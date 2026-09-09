#!/usr/bin/env python3
"""
clip.py - end-to-end clipper. One command: long video in, finished clips out.

  URL or file
    -> download (full file, -N 16, FORCE H.264)      ~14 s for a 75-min video
    -> download word-level captions (json3)          ~7 s, free, no Whisper
    -> score moments (transcript + audio + scene)    ~63 s for 75 min
    -> per clip: build ASS captions
    -> per clip: face-tracking reframe + burn captions, ONE encode
    -> manifest.json

Progress is emitted as JSON lines on stdout so a worker/UI can render a
progress bar. Human-readable log goes to stderr.

Usage:
  python clip.py --url "https://youtube.com/watch?v=..." --outdir out --max-clips 20
  python clip.py --video local.mp4 --captions subs.json3 --outdir out
  python clip.py --url "..." --profile talking --encoder nvenc --workers 2
"""

import argparse
import glob
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable


def emit(stage, **kw):
    """Machine-readable progress line."""
    print(json.dumps({"stage": stage, **kw}), flush=True)


def log(msg):
    print(f"[clip] {msg}", file=sys.stderr, flush=True)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def download(url, outdir, height):
    """Full file at high concurrency. NEVER --download-sections: that routes
    through ffmpeg's single-connection downloader, ignores -N, and YouTube
    throttles it to ~137 B/s. Full download of a 75-min video takes 13 s."""
    base = os.path.join(outdir, "source")
    fmt = (f"bv*[height<={height}][vcodec^=avc1]+ba[ext=m4a]/"
           f"b[height<={height}][vcodec^=avc1]/b[height<={height}]")
    cmd = [PY, "-m", "yt_dlp", "--no-warnings", "-N", "16",
           "-f", fmt, "--merge-output-format", "mp4",
           "-o", base + ".%(ext)s", url]
    r = run(cmd)
    for ext in (".mp4", ".mkv", ".webm"):
        if os.path.exists(base + ext):
            return base + ext
    sys.exit(f"download failed:\n{r.stderr[-800:]}")


def get_captions(url, outdir, lang):
    """YouTube's own captions - free, word-level, ~7s. Returns None on failure
    (no captions, or HTTP 429 when the endpoint has been hit too often), and
    the caller falls back to Whisper."""
    base = os.path.join(outdir, "subs")
    r = run([PY, "-m", "yt_dlp", "--no-warnings", "--skip-download",
             "--write-auto-sub", "--write-sub", "--sub-lang", lang,
             "--sub-format", "json3", "-o", base, url])
    # yt-dlp may write subs.en.json3, subs.en-orig.json3, subs.en-US.json3 ...
    # so glob rather than guessing the exact suffix.
    hits = sorted(glob.glob(base + "*.json3"))
    if hits:
        return hits[0]
    tail = (r.stderr or "").strip().splitlines()
    if tail:
        log(f"captions unavailable: {tail[-1][:160]}")
    return None


def whisper_captions(video, outdir, model="base"):
    """Fallback transcript. Emits json3-shaped output so nothing downstream
    needs to care where the words came from."""
    out = os.path.join(outdir, "subs.whisper.json3")
    r = run([PY, os.path.join(HERE, "transcribe.py"),
             "--video", video, "--out", out, "--model", model])
    if os.path.exists(out):
        return out
    log(f"whisper failed: {(r.stderr or '')[-200:]}")
    return None


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--url")
    src.add_argument("--video")
    ap.add_argument("--captions")
    ap.add_argument("--outdir", default="clips_out")
    ap.add_argument("--profile", choices=["talking", "energy", "balanced"],
                    default="balanced")
    ap.add_argument("--max-clips", type=int, default=20)
    ap.add_argument("--min-clips", type=int, default=5)
    ap.add_argument("--encoder", choices=["x264", "nvenc"], default="nvenc")
    ap.add_argument("--ratio", default="9:16")
    ap.add_argument("--height", type=int, default=1080,
                    help="max source height to download")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--no-captions", action="store_true",
                    help="skip burned-in captions")
    ap.add_argument("--no-scene", action="store_true")
    ap.add_argument("--no-whisper", action="store_true",
                    help="do not fall back to Whisper when captions are missing")
    ap.add_argument("--whisper-model", default="base",
                    help="base = fast (6.4x realtime), small = more accurate")
    a = ap.parse_args()

    os.makedirs(a.outdir, exist_ok=True)
    t_all = time.time()

    # 1. source ------------------------------------------------------------
    if a.url:
        emit("download", status="start")
        t = time.time()
        video = download(a.url, a.outdir, a.height)
        log(f"downloaded {os.path.basename(video)} in {time.time() - t:.0f}s")
        emit("download", status="done", seconds=round(time.time() - t, 1))

        caps = a.captions
        if not caps and not a.no_captions:
            emit("captions", status="start")
            t = time.time()
            caps = get_captions(a.url, a.outdir, a.lang)
            source = "youtube"
            if not caps and not a.no_whisper:
                # Without a transcript there is no transcript scoring, no
                # speech-gap boundary snapping (every clip comes out the same
                # fixed length) and no burned-in captions. Worth the minutes.
                log("no YouTube captions - falling back to Whisper")
                emit("captions", status="fallback", engine="whisper")
                caps = whisper_captions(video, a.outdir, a.whisper_model)
                source = "whisper"
            log(f"captions: {os.path.basename(caps) if caps else 'NONE'} "
                f"({source if caps else 'none'}, {time.time() - t:.0f}s)")
            emit("captions", status="done", found=bool(caps), source=source)
    else:
        video, caps = a.video, a.captions
        if not caps and not a.no_captions and not a.no_whisper:
            log("no captions supplied - transcribing with Whisper")
            emit("captions", status="fallback", engine="whisper")
            t = time.time()
            caps = whisper_captions(video, a.outdir, a.whisper_model)
            emit("captions", status="done", found=bool(caps), source="whisper")

    # 2. score -------------------------------------------------------------
    emit("score", status="start")
    t = time.time()
    clips_json = os.path.join(a.outdir, "clips.json")
    cmd = [PY, os.path.join(HERE, "score_moments.py"),
           "--video", video, "--profile", a.profile,
           "--max-clips", str(a.max_clips), "--min-clips", str(a.min_clips),
           "--out", clips_json]
    if caps:
        cmd += ["--captions", caps]
    if a.no_scene:
        cmd += ["--no-scene"]
    r = run(cmd)
    if not os.path.exists(clips_json):
        sys.exit(f"scoring failed:\n{r.stderr[-800:]}")
    data = json.load(open(clips_json, encoding="utf-8"))
    clips = data["clips"]
    log(f"scored {len(clips)} clips in {time.time() - t:.0f}s")
    emit("score", status="done", clips=len(clips),
         seconds=round(time.time() - t, 1))

    # 3. render ------------------------------------------------------------
    rw, rh = (int(v) for v in a.ratio.split(":"))
    out_h = 1920 if rh >= rw else 1080
    made = []

    for i, c in enumerate(clips, 1):
        name = f"clip_{i:02d}.mp4"
        out = os.path.join(a.outdir, name)
        emit("render", status="start", index=i, total=len(clips),
             start=c["start"], duration=c["duration"])
        t = time.time()

        subs = None
        if caps and not a.no_captions:
            subs = os.path.join(a.outdir, f"clip_{i:02d}.ass")
            run([PY, os.path.join(HERE, "captions.py"),
                 "--captions", caps, "--start", str(c["start"]),
                 "--duration", str(c["duration"]), "--out", subs,
                 "--height", str(out_h)])

        cmd = [PY, os.path.join(HERE, "autoreframe.py"),
               "--input", video, "--output", out,
               "--start", str(c["start"]), "--duration", str(c["duration"]),
               "--ratio", a.ratio, "--height", str(out_h),
               "--encoder", a.encoder]
        if subs and os.path.exists(subs):
            cmd += ["--subs", subs]
        r = run(cmd)

        if os.path.exists(out) and os.path.getsize(out) > 0:
            el = time.time() - t
            made.append({**c, "file": name,
                         "bytes": os.path.getsize(out),
                         "render_seconds": round(el, 1)})
            log(f"[{i}/{len(clips)}] {name} {c['duration']:.1f}s -> {el:.0f}s")
            emit("render", status="done", index=i, file=name,
                 seconds=round(el, 1))
        else:
            log(f"[{i}/{len(clips)}] FAILED: {r.stderr[-300:]}")
            emit("render", status="error", index=i)

    # 4. manifest ----------------------------------------------------------
    manifest = os.path.join(a.outdir, "manifest.json")
    total = time.time() - t_all
    with open(manifest, "w", encoding="utf-8") as fh:
        json.dump({"source": video, "profile": a.profile,
                   "encoder": a.encoder, "ratio": a.ratio,
                   "total_seconds": round(total, 1),
                   "clips": made}, fh, indent=2)

    log(f"DONE {len(made)}/{len(clips)} clips in {total / 60:.1f} min -> {a.outdir}")
    emit("complete", clips=len(made), seconds=round(total, 1),
         manifest=manifest)


if __name__ == "__main__":
    main()
