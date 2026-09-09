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
SPEAK_MARGIN = 2.0     # a rival must be this much more active to steal focus
MIN_HOLD_SEC = 3.0     # never cut faster than this. At 1.5s the result was 16
                       # cuts in 22s, which is frantic. A cut every 3-5s is a
                       # natural editing rhythm.
MOUTH_PATCH = (24, 16) # normalised mouth crop, w x h
TRACK_DIST_FRAC = 0.12 # match a face to an existing track within this fraction
                       # of frame width. Too tight and one person's track BREAKS
                       # when they move, re-registers as a new id, and that reads
                       # as a speaker change -> a spurious cut. 0.06 produced 14
                       # tracks for ~6 people.
TRACK_TTL = 12         # keep a track alive this many samples after it was last
                       # seen, so a brief detection dropout does not spawn a new
                       # identity (and therefore a false cut).
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

    samples = []          # (t, centre_x or None, speaker_id or None)
    tracks = []           # per-person mouth history, matched across samples
    speaker_id = None     # who we are currently on
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
        cur_id = None
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
            # Match each detection to a persistent track so mouth history
            # follows a PERSON, not a slot in the list.
            tol = TRACK_DIST_FRAC * w
            live = []
            for d in dets:
                best, bestd = None, tol
                for tr in tracks:
                    dist = abs(tr["cx"] - d["cx"])
                    if dist < bestd:
                        best, bestd = tr, dist
                if best is None:
                    best = {"id": len(tracks), "cx": d["cx"], "patches": [],
                            "energy": 0.0, "area": d["area"]}
                    tracks.append(best)
                best["cx"] = d["cx"]
                best["area"] = d["area"]
                best["seen"] = idx
                raw = mouth_energy(frame, d["mouth"], best)
                # smooth the instantaneous energy so one noisy frame cannot
                # steal focus, but stay responsive enough to catch a new answer
                best["energy"] = 0.6 * best["energy"] + 0.4 * raw
                live.append(best)

            # retire only tracks unseen for a while - see TRACK_TTL
            tracks = [tr for tr in tracks
                      if idx - tr.get("seen", idx) <= TRACK_TTL * every]

            if live:
                loud = max(live, key=lambda tr: tr["energy"])
                cur = next((tr for tr in live if tr["id"] == speaker_id), None)
                if cur is None:
                    speaker_id, hold_until = loud["id"], t + MIN_HOLD_SEC
                elif (t >= hold_until
                      and loud["id"] != speaker_id
                      and loud["energy"] > cur["energy"] * SPEAK_MARGIN):
                    speaker_id, hold_until = loud["id"], t + MIN_HOLD_SEC
                chosen = next((tr for tr in live if tr["id"] == speaker_id), loud)
                cx = chosen["cx"]
                cur_id = chosen["id"]

        samples.append((t, cx, cur_id))

    cap.release()

    if not samples:
        sys.exit("no frames sampled")

    # PASS TWO - smooth WITHIN each speaker, CUT between them.
    #
    # Panning between speakers was the swaying: with 3-6 faces the subject
    # changes every few seconds, and a slow pan across the frame never settles.
    # Real editors CUT between speakers. So each run of samples on one person is
    # smoothed independently, and the boundary between runs is an instant jump.
    known = [c for _, c, _ in samples if c is not None]
    if not known:
        if debug:
            print("[autoreframe] no faces found - using centre crop", file=sys.stderr)
        return [(t, src_w / 2.0) for t, _, _ in samples]

    # hold position and speaker through frames where detection dropped out
    filled, last_cx, last_id = [], known[0], None
    for t, cx, sid in samples:
        if cx is not None:
            last_cx, last_id = cx, sid
        filled.append((t, last_cx, last_id))

    # split into runs of the same speaker
    runs, cur = [], [filled[0]]
    for row in filled[1:]:
        if row[2] != cur[-1][2]:
            runs.append(cur)
            cur = [row]
        else:
            cur.append(row)
    runs.append(cur)

    if debug:
        print(f"[autoreframe] {len(tracks)} people, {len(runs)} speaker "
              f"segments (cuts, not pans)", file=sys.stderr)

    out = []
    half = crop_w / 2.0
    dead = DEADZONE_FRAC * crop_w
    max_step = (MAX_PAN_FRAC * crop_w) / SAMPLE_HZ

    for run in runs:
        xs = np.array([c for _, c, _ in run], dtype=np.float64)

        if len(xs) >= MEDIAN_WIN:
            pad = MEDIAN_WIN // 2
            padded = np.pad(xs, pad, mode="edge")
            xs = np.array([np.median(padded[i:i + MEDIAN_WIN])
                           for i in range(len(xs))])

        def ema(a, alpha):
            res = np.empty_like(a)
            acc = a[0]
            for i, v in enumerate(a):
                acc = alpha * v + (1 - alpha) * acc
                res[i] = acc
            return res

        if len(xs) > 2:
            xs = ema(xs, EMA_ALPHA)
            xs = ema(xs[::-1], EMA_ALPHA)[::-1]

        # Within a speaker the subject barely moves, so hold still unless they
        # genuinely shift, then ease. No easing ACROSS runs - that is the cut.
        held = xs.copy()
        cur_pos = float(xs[0])
        moving = False
        for i, v in enumerate(xs):
            if abs(v - cur_pos) > dead:
                moving = True
            elif abs(v - cur_pos) < dead * 0.25:
                moving = False
            if moving:
                cur_pos += max(-max_step, min(max_step, v - cur_pos))
            held[i] = cur_pos

        held = np.clip(held, half, src_w - half)
        out.extend(zip([t for t, _, _ in run], held))

    return out


def face_extent(path, start, duration, src_w):
    """Horizontal span covering every face seen during the clip.

    Fitting the WHOLE 1920 frame into a 1080-wide canvas leaves the subjects a
    small strip. Cropping to the group first makes them substantially larger
    while still including everyone.
    """
    det = cv2.FaceDetectorYN.create(MODEL, "", (320, 320), CONF_THRESH, 0.3, 5000)
    cap = cv2.VideoCapture(path)
    if start:
        cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    every = max(1, int(round(fps / 3.0)))     # 3 Hz is plenty for an extent
    lo, hi, idx = src_w, 0.0, 0
    while True:
        ok, frame = cap.read()
        if not ok or idx / fps >= duration:
            break
        if idx % every:
            idx += 1
            continue
        idx += 1
        h, w = frame.shape[:2]
        det.setInputSize((w, h))
        _, faces = det.detect(frame)
        if faces is None:
            continue
        for f in faces:
            if f[2] < MIN_FACE_FRAC * w:
                continue
            lo = min(lo, float(f[0]))
            hi = max(hi, float(f[0] + f[2]))
    cap.release()
    if hi <= lo:
        return 0.0, float(src_w)
    pad = (hi - lo) * 0.12 + 40          # breathing room around the group
    return max(0.0, lo - pad), min(float(src_w), hi + pad)


def render_fit(src, out, start, duration, out_w, out_h, debug, subs=None,
               extent=None):
    """WIDE MODE - no crop, no tracking.

    Fits the FULL source width into the vertical frame and fills the rest with a
    blurred, scaled copy of the same footage. Nobody is ever cut out, so it
    sidesteps speaker identification entirely.

    This is the right mode for panels, interviews and group tables, where a 9:16
    crop of a 1920 frame is only ~600px - a third of the width - and picking the
    wrong third is worse than showing everyone.
    """
    tmpdir = tempfile.mkdtemp(prefix="autoreframe_")
    pre = ""
    if extent:
        x0, x1 = extent
        cw = int(x1 - x0) // 2 * 2
        if cw > 32:
            pre = f"crop={cw}:ih:{int(x0) // 2 * 2}:0,"
    vf = (
        pre +
        f"split=2[bg][fg];"
        f"[bg]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
        f"crop={out_w}:{out_h},boxblur=luma_radius=40:luma_power=2,"
        f"eq=brightness=-0.12[bgb];"
        f"[fg]scale={out_w}:-2[fgs];"
        f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1"
    )
    if subs and os.path.exists(subs):
        shutil.copyfile(subs, os.path.join(tmpdir, "subs.ass"))
        vf += ",subtitles=subs.ass"

    if ENCODER == "nvenc":
        venc = ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "29"]
        exe = FFMPEG7 if os.path.exists(FFMPEG7) else "ffmpeg"
    else:
        venc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
        exe = "ffmpeg"

    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error",
           "-ss", str(start), "-t", str(duration), "-i", os.path.abspath(src),
           "-vf", vf, *venc, "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
           os.path.abspath(out)]
    subprocess.run(cmd, cwd=tmpdir, check=True)


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
    ap.add_argument("--fit", action="store_true",
                    help="WIDE mode: fit the whole frame with a blurred "
                         "background instead of cropping. Best for panels and "
                         "group shots - nobody gets cut out.")
    ap.add_argument("--auto-wide", type=int, default=0, metavar="N",
                    help="use wide mode automatically when more than N faces "
                         "are typically on screen (0 = off)")
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

    if a.fit:
        if a.debug:
            print("[autoreframe] WIDE mode - full frame, blurred fill",
                  file=sys.stderr)
        ext = face_extent(a.input, a.start, duration, src_w)
        if a.debug:
            print(f"[autoreframe] group extent x {ext[0]:.0f}-{ext[1]:.0f} "
                  f"of {src_w} ({(ext[1]-ext[0])/src_w*100:.0f}% of width)",
                  file=sys.stderr)
        render_fit(a.input, a.output, a.start, duration,
                   out_w, out_h, a.debug, a.subs, ext)
        print(a.output)
        return

    track = analyse(a.input, a.start, duration, crop_w, src_w, src_h, a.debug)
    render(a.input, a.output, a.start, duration, track,
           crop_w, crop_h, out_w, out_h, a.debug, a.subs)
    print(a.output)


if __name__ == "__main__":
    main()
