#!/usr/bin/env python3
"""
autoreframe.py - face-tracking vertical reframe for clip generation.

Turns a landscape source into a 9:16 (or any ratio) vertical clip whose crop
window FOLLOWS THE SPEAKER, instead of a static centre crop with blurred bars.
This is the visual difference between a homemade clipper and OpusClip/Ssemble.

Two passes:
  1. ANALYSE - sample frames, detect faces with OpenCV YuNet, build a smoothed
     horizontal crop path.
  2. RENDER  - drive ffmpeg's crop filter with a sendcmd file so ALL encoding
     stays in ffmpeg (fast, good quality, audio preserved automatically).

Usage:
  python autoreframe.py --input in.mp4 --output out.mp4
  python autoreframe.py --input in.mp4 --output out.mp4 --start 120 --duration 45
  python autoreframe.py --input in.mp4 --output out.mp4 --ratio 1:1 --debug

Requires: opencv-python, numpy, ffmpeg on PATH, and models/face_detection_yunet_*.onnx
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "face_detection_yunet_2023mar.onnx")

# --- tuning -----------------------------------------------------------------
SAMPLE_HZ = 8.0      # face-detection samples per second (cost vs responsiveness)
CMD_HZ = 25.0        # crop-update commands per second written to ffmpeg.
                     # sendcmd sets crop x as a STEP function, so a low rate
                     # makes each change a visible jump. 25 keeps steps small.
EMA_ALPHA = 0.08     # lower = smoother/laggier camera
MEDIAN_WIN = 7       # median filter width, kills single-frame detection spikes
DEADZONE_FRAC = 0.035  # ignore drift under this fraction of the CROP WIDTH.
                     # MUST be relative to the crop window, not the source:
                     # the crop is what the viewer sees, and it is then upscaled
                     # to 1080. Measured against a 1920 source these values came
                     # out ~3x too large - an 11%-of-frame deadzone followed by a
                     # 32%-of-frame-per-second pan. That was the shaking.
MAX_PAN_FRAC = 0.10  # max pan speed as a fraction of the CROP WIDTH per second.
                     # ~10%/s reads as a deliberate camera move rather than a
                     # correction. The original code SNAPPED to the target the
                     # moment drift exceeded the deadzone, jumping the full
                     # deadzone width in a single sample.
SWITCH_MARGIN = 1.35 # a rival face must be this much bigger to steal focus
                     # (only used when nobody is detectably speaking)

# --- active speaker detection ----------------------------------------------
# With 3-6 faces at a table, "biggest face" is meaningless - the choice flips as
# sizes fluctuate and the crop sways between people. What matters is WHO IS
# TALKING. YuNet gives 5 landmarks per face including both mouth corners, so we
# can watch the mouth region and score how much it is moving.
SPEAK_HISTORY = 8      # mouth patches kept per face (~1s at SAMPLE_HZ)
SPEAK_MARGIN = 1.5     # a rival must be this much more active to steal focus
MIN_HOLD_SEC = 1.5     # never switch speaker faster than this - rapid cuts
                       # between faces look worse than staying on the wrong one
MOUTH_PATCH = (24, 16) # normalised mouth crop, w x h
TRACK_DIST_FRAC = 0.06 # match a face to the previous frame within this
                       # fraction of frame width
CONF_THRESH = 0.6
MIN_FACE_FRAC = 0.028  # ignore faces narrower than this fraction of frame width.
                       # Stops the crop locking onto faces on posters, screens,
                       # drawings and background extras instead of the subject.
ENCODER = "x264"        # set to "nvenc" for NVIDIA GPU encoding

# NVENC on Pascal (GTX 10xx) needs an ffmpeg built against NVENC API 13.0.
# ffmpeg 8.x demands API 13.1 (driver 610+), which Pascal will NEVER get --
# R580 is the last driver branch for that generation. So we ship a 7.x binary
# and use it ONLY for nvenc renders. Everything else uses the system ffmpeg.
FFMPEG7 = os.path.join(HERE, "ffmpeg7", "ffmpeg.exe")


def probe(path):
    """Return (width, height, duration, fps) via ffprobe."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate:format=duration",
         "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    st = j["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    fps = float(num) / float(den or 1)
    return int(st["width"]), int(st["height"]), float(j["format"]["duration"]), fps



def mouth_energy(frame, mouth, track):
    """How much this face's mouth is moving.

    Crops the mouth region using YuNet's two mouth-corner landmarks, normalises
    it to a fixed small patch, and returns the mean absolute difference against
    recent patches. A talking mouth changes shape constantly; a listening one
    barely does. This is a cheap stand-in for real audio-visual speaker
    detection - no extra model, no extra dependency.
    """
    rmx, rmy, lmx, lmy = mouth
    cx, cy = (rmx + lmx) / 2.0, (rmy + lmy) / 2.0
    half = max(8.0, abs(lmx - rmx))          # mouth width, with a floor
    x0, x1 = int(cx - half), int(cx + half)
    y0, y1 = int(cy - half * 0.7), int(cy + half * 0.7)
    h, w = frame.shape[:2]
    x0, x1 = max(0, x0), min(w, x1)
    y0, y1 = max(0, y0), min(h, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return 0.0

    patch = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    patch = cv2.resize(patch, MOUTH_PATCH).astype(np.float32)
    # Normalise brightness so lighting changes are not read as speech.
    patch -= patch.mean()
    sd = patch.std()
    if sd > 1e-6:
        patch /= sd

    hist = track["patches"]
    energy = 0.0
    if hist:
        energy = float(np.mean([np.abs(patch - p).mean() for p in hist[-3:]]))
    hist.append(patch)
    if len(hist) > SPEAK_HISTORY:
        hist.pop(0)
    return energy


def analyse(path, start, duration, crop_w, src_w, src_h, debug=False):
    """Sample frames, track the primary face, return [(t, centre_x), ...]."""
    det = cv2.FaceDetectorYN.create(MODEL, "", (320, 320), CONF_THRESH, 0.3, 5000)

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        sys.exit(f"cannot open {path}")

    # Seek ONCE, then decode sequentially. Seeking per sample is catastrophically
    # slow on a long file (it was 4x realtime); sequential decode is ~10x faster.
    if start:
        cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    every = max(1, int(round(fps / SAMPLE_HZ)))   # run detection every Nth frame

    samples = []          # (t, centre_x or None)
    locked_cx = None      # centre of the face we are currently following
    tracks = []           # per-person mouth history, matched across samples
    hold_until = 0.0      # do not switch speaker before this time
    idx = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = idx / fps
        if t >= duration:
            break
        if idx % every:                            # cheap decode, skip detection
            idx += 1
            continue
        idx += 1

        h, w = frame.shape[:2]
        det.setInputSize((w, h))
        _, faces = det.detect(frame)

        cx = None
        dets = []
        if faces is not None and len(faces):
            min_w = MIN_FACE_FRAC * w
            for f in faces:
                if f[2] < min_w:
                    continue
                dets.append({
                    "cx": float(f[0] + f[2] / 2.0),
                    "area": float(f[2] * f[3]),
                    # landmarks 10..13 are the two mouth corners
                    "mouth": (float(f[10]), float(f[11]),
                              float(f[12]), float(f[13])),
                })

        if dets:
            # Match each detection to a persistent track so mouth history and
            # accumulated speaking time follow a PERSON, not a list slot.
            tol = TRACK_DIST_FRAC * w
            for d in dets:
                best, bestd = None, tol
                for tr in tracks:
                    dist = abs(tr["cx"] - d["cx"])
                    if dist < bestd:
                        best, bestd = tr, dist
                if best is None:
                    best = {"cx": d["cx"], "patches": [], "total": 0.0,
                            "pos": {}, "area": d["area"]}
                    tracks.append(best)
                best["cx"] = d["cx"]
                best["area"] = d["area"]
                best["pos"][len(samples)] = d["cx"]
                best["total"] += mouth_energy(frame, d["mouth"], best)

        samples.append((t, None))       # positions are resolved in pass two
        continue

    cap.release()

    if not samples:
        sys.exit("no frames sampled")

    # PASS TWO - pick the dominant speaker for the WHOLE clip and follow only
    # them.
    #
    # Following the live conversation looks terrible: with 3-6 faces the crop
    # switches every couple of seconds, and because each switch is a slow pan it
    # never settles - it just sways. Clips are ~20s, so choosing one subject and
    # holding is far more watchable. Real editors cut between speakers; they do
    # not pan back and forth.
    if tracks:
        best = max(tracks, key=lambda tr: tr["total"])
        if debug:
            ranked = sorted((tr["total"] for tr in tracks), reverse=True)[:4]
            print(f"[autoreframe] {len(tracks)} people, speaking energy "
                  f"{[round(x, 1) for x in ranked]}", file=sys.stderr)
        pos = best["pos"]
        filled_cx, last = [], None
        for i in range(len(samples)):
            if i in pos:
                last = pos[i]
            filled_cx.append(last)
        # backfill anything before the speaker first appears
        first = next((v for v in filled_cx if v is not None), None)
        samples = [(samples[i][0],
                    filled_cx[i] if filled_cx[i] is not None else first)
                   for i in range(len(samples))]

    # Fill gaps (no face detected) by holding the last known position; if we
    # never saw a face at all, fall back to centre.
    known = [s[1] for s in samples if s[1] is not None]
    if not known:
        if debug:
            print("[autoreframe] no faces found - using centre crop", file=sys.stderr)
        return [(s[0], src_w / 2.0) for s in samples]

    filled, last = [], known[0]
    for tt, cx in samples:
        if cx is not None:
            last = cx
        filled.append((tt, last))

    xs = np.array([c for _, c in filled], dtype=np.float64)

    # Median filter removes one-off detection spikes before smoothing.
    if len(xs) >= MEDIAN_WIN:
        pad = MEDIAN_WIN // 2
        padded = np.pad(xs, pad, mode="edge")
        xs = np.array([np.median(padded[i:i + MEDIAN_WIN]) for i in range(len(xs))])

    # Exponential moving average, run forward then backward for zero phase lag.
    def ema(a, alpha):
        out = np.empty_like(a)
        acc = a[0]
        for i, v in enumerate(a):
            acc = alpha * v + (1 - alpha) * acc
            out[i] = acc
        return out

    xs = ema(xs, EMA_ALPHA)
    xs = ema(xs[::-1], EMA_ALPHA)[::-1]

    # Deadzone + velocity limit.
    #
    # Hold still for small drift, and when the subject genuinely moves, EASE
    # toward them at a bounded speed. The previous version set `cur = v` the
    # instant drift exceeded the deadzone, which teleported the crop by the full
    # deadzone width in a single sample - the shaking that showed up on real
    # footage. Clamping the per-sample step turns that into a smooth pan.
    dead = DEADZONE_FRAC * crop_w
    max_step = (MAX_PAN_FRAC * crop_w) / SAMPLE_HZ   # px per sample
    held = xs.copy()
    cur = float(xs[0])
    moving = False
    for i, v in enumerate(xs):
        # Hysteresis: start moving once outside the deadzone, keep moving until
        # essentially on target. Without this it stutters at the boundary.
        if abs(v - cur) > dead:
            moving = True
        elif abs(v - cur) < dead * 0.25:
            moving = False
        if moving:
            delta = v - cur
            cur += max(-max_step, min(max_step, delta))
        held[i] = cur

    # Clamp so the crop window never leaves the frame.
    half = crop_w / 2.0
    held = np.clip(held, half, src_w - half)
    return list(zip([t for t, _ in filled], held))


def render(src, out, start, duration, track, crop_w, crop_h, out_w, out_h, debug, subs=None):
    """Drive ffmpeg's crop filter over time with a sendcmd file."""
    tmpdir = tempfile.mkdtemp(prefix="autoreframe_")
    cmds = os.path.join(tmpdir, "crop.cmd")

    # Resample the track onto the command grid.
    ts = np.array([t for t, _ in track])
    xs = np.array([x for _, x in track])
    grid = np.arange(0, duration, 1.0 / CMD_HZ)
    vals = np.interp(grid, ts, xs)

    lines, last = [], None
    for t, cx in zip(grid, vals):
        x = int(round(cx - crop_w / 2.0))
        if x != last:                       # only emit on change
            lines.append(f"{t:.3f} crop x {x};")
            last = x
    with open(cmds, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    if debug:
        print(f"[autoreframe] {len(lines)} crop commands -> {cmds}", file=sys.stderr)

    # Run ffmpeg from the temp dir so the sendcmd path needs no Windows escaping.
    vf = (f"sendcmd=f=crop.cmd,"
          f"crop=w={crop_w}:h={crop_h}:x={int(xs[0] - crop_w / 2)}:y=0,"
          f"scale={out_w}:{out_h}:flags=lanczos,setsar=1")

    # Burn captions in the SAME encode - no second pass, no extra generation
    # loss. Copied into tmpdir so the filter path needs no Windows escaping.
    if subs and os.path.exists(subs):
        shutil.copyfile(subs, os.path.join(tmpdir, "subs.ass"))
        vf += ",subtitles=subs.ass"

    if ENCODER == "nvenc":
        # p5/cq29 measured to match libx264 veryfast/crf20 file size at 4x speed.
        venc = ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "29"]
        exe = FFMPEG7 if os.path.exists(FFMPEG7) else "ffmpeg"
    else:
        venc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
        exe = "ffmpeg"

    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error",
           "-ss", str(start), "-t", str(duration), "-i", os.path.abspath(src),
           "-vf", vf, *venc,
           "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "128k",
           "-movflags", "+faststart",
           os.path.abspath(out)]
    subprocess.run(cmd, cwd=tmpdir, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--duration", type=float, default=None)
    ap.add_argument("--ratio", default="9:16", help="target aspect, e.g. 9:16, 1:1, 4:5")
    ap.add_argument("--height", type=int, default=1920, help="output height")
    ap.add_argument("--encoder", choices=["x264", "nvenc"], default="x264")
    ap.add_argument("--subs", help="ASS subtitle file to burn in")
    ap.add_argument("--debug", action="store_true")
    a = ap.parse_args()

    global ENCODER
    ENCODER = a.encoder

    if not os.path.exists(MODEL):
        sys.exit(f"missing YuNet model at {MODEL}")

    src_w, src_h, src_dur, fps = probe(a.input)
    duration = a.duration if a.duration else max(0.0, src_dur - a.start)

    rw, rh = (int(v) for v in a.ratio.split(":"))
    out_h = a.height
    out_w = int(round(out_h * rw / rh))
    out_w -= out_w % 2

    # Largest window of the target ratio that fits inside the source.
    crop_h = src_h
    crop_w = int(round(crop_h * rw / rh))
    if crop_w > src_w:
        crop_w = src_w
        crop_h = int(round(crop_w * rh / rw))
    crop_w -= crop_w % 2
    crop_h -= crop_h % 2

    if a.debug:
        print(f"[autoreframe] src {src_w}x{src_h} {fps:.2f}fps {src_dur:.1f}s", file=sys.stderr)
        print(f"[autoreframe] crop {crop_w}x{crop_h} -> out {out_w}x{out_h}", file=sys.stderr)

    track = analyse(a.input, a.start, duration, crop_w, src_w, src_h, a.debug)
    render(a.input, a.output, a.start, duration, track,
           crop_w, crop_h, out_w, out_h, a.debug, a.subs)
    print(a.output)


if __name__ == "__main__":
    main()
