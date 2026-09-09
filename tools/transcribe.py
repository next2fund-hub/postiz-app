#!/usr/bin/env python3
"""
transcribe.py - Whisper fallback that emits YouTube json3-shaped captions.

Used when YouTube captions are unavailable: your own uploads, non-YouTube
sources, or - as actually happened - YouTube returning HTTP 429 because the
caption endpoint has been hit too often.

The output deliberately mimics YouTube's json3 structure so that
score_moments.py and captions.py need no special-casing:

    {"events": [{"tStartMs": 1700, "segs": [{"utf8": "word", "tOffsetMs": 0}]}]}

Word-level timestamps are required - they drive both the karaoke caption
highlight and the speech-gap boundary snapping that stops every clip coming
out the same length.

Speed on CPU (measured on this machine, int8):
    base   6.4x realtime   ~12 min for a 75-min video   (good enough for scoring)
    small  2.6x realtime   ~29 min                      (noticeably more accurate)

Usage:
  python transcribe.py --video source.mp4 --out subs.en.json3
  python transcribe.py --video source.mp4 --out subs.json3 --model small
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time


def extract_audio(video):
    """16 kHz mono wav - what Whisper wants, and small."""
    fd, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", video,
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
        check=True)
    return wav


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="base",
                    help="base = fast, good enough for scoring; "
                         "small = slower, better words for burned-in captions")
    ap.add_argument("--language", default=None, help="force a language code")
    a = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper not installed:  pip install faster-whisper")

    wav = extract_audio(a.video)
    try:
        print(f"[transcribe] model={a.model} on {os.path.basename(a.video)}",
              file=sys.stderr, flush=True)
        t0 = time.time()
        model = WhisperModel(a.model, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            wav, word_timestamps=True, vad_filter=True, language=a.language)

        events = []
        words = 0
        for seg in segments:
            for w in (seg.words or []):
                text = (w.word or "").strip()
                if not text:
                    continue
                events.append({
                    "tStartMs": int(w.start * 1000),
                    "dDurationMs": max(1, int((w.end - w.start) * 1000)),
                    "segs": [{"utf8": text, "tOffsetMs": 0}],
                })
                words += 1

        with open(a.out, "w", encoding="utf-8") as fh:
            json.dump({"events": events}, fh)

        el = time.time() - t0
        dur = getattr(info, "duration", 0) or 0
        rate = f"{dur / el:.1f}x realtime" if el and dur else "?"
        print(f"[transcribe] {words} words, lang={info.language}, "
              f"{el:.0f}s ({rate}) -> {a.out}", file=sys.stderr)
        print(a.out)
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass


if __name__ == "__main__":
    main()
