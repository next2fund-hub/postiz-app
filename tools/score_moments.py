#!/usr/bin/env python3
"""
score_moments.py - decide WHICH parts of a long video become clips.

Combines three independent signals into a per-second score, then picks
non-overlapping windows around the peaks.

  1. TRANSCRIPT  questions, emphasis, speech density, topic shifts
                 (from YouTube json3 captions - free, word-level, no Whisper)
  2. AUDIO       loudness envelope: laughter, shouting, crowd reaction
                 (raw PCM via ffmpeg -> RMS per second)
  3. SCENE       shot changes / visual activity
                 (ffmpeg scene filter on a low-res, low-fps proxy)

Weighting is per CONTENT TYPE, because the signal lives in different places:
  talking  -> podcasts, interviews, own long-form. Transcript dominates.
  energy   -> reaction, gaming, live streams. Audio dominates; speech is sparse.

Usage:
  python score_moments.py --video full.mp4 --captions subs.en.json3 --out clips.json
  python score_moments.py --video in.mp4 --captions c.json3 --profile energy --max-clips 20
"""

import argparse
import json
import os
import re
import subprocess
import sys

import numpy as np

# --- selection defaults (user spec) -----------------------------------------
MIN_CLIPS = 5
MAX_CLIPS = 20
MIN_DUR = 15.0
MAX_DUR = 60.0
LEAD_IN = 5.0        # start this many seconds before the peak
LEAD_OUT = 14.0      # and end this many after (then run on to the
                     # next SENTENCE END - see snap_end)
AUDIO_HZ = 1000      # PCM sample rate for the energy envelope

PROFILES = {
    # transcript, audio, scene
    "talking": (0.55, 0.25, 0.20),
    "energy":  (0.20, 0.60, 0.20),
    "balanced": (0.40, 0.40, 0.20),
}

HOOK_WORDS = {
    "crazy", "insane", "wait", "actually", "literally", "never", "always",
    "secret", "nobody", "everyone", "worst", "best", "biggest", "first",
    "stop", "look", "listen", "watch", "why", "how", "what", "imagine",
}


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def duration_of(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "csv=p=0", path]).stdout.strip()
    return float(out)


# ---------------------------------------------------------------- transcript
def load_words(captions_path):
    """YouTube json3 -> [(t_seconds, word), ...] using word-level offsets."""
    with open(captions_path, encoding="utf-8") as fh:
        data = json.load(fh)
    words = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        base = ev.get("tStartMs", 0)
        for s in segs:
            txt = s.get("utf8", "")
            if not txt.strip():
                continue
            words.append(((base + s.get("tOffsetMs", 0)) / 1000.0, txt.strip()))
    return words


def transcript_score(words, n_sec):
    """Per-second transcript signal."""
    score = np.zeros(n_sec)
    if not words:
        return score

    # speech density: words per second, smoothed
    density = np.zeros(n_sec)
    for t, _ in words:
        i = int(t)
        if 0 <= i < n_sec:
            density[i] += 1.0

    # hook words and questions land as point bonuses
    for t, w in words:
        i = int(t)
        if not (0 <= i < n_sec):
            continue
        lw = re.sub(r"[^a-z']", "", w.lower())
        if lw in HOOK_WORDS:
            score[i] += 1.0
        if "?" in w:
            score[i] += 2.0          # questions are strong engagement hooks
        if w.isupper() and len(w) > 2:
            score[i] += 0.5          # shouted / emphasised

    # topic shift: a gap in speech usually precedes a new thought
    times = [t for t, _ in words]
    for a, b in zip(times, times[1:]):
        if 1.2 < (b - a) < 8.0:
            i = int(b)
            if 0 <= i < n_sec:
                score[i] += 1.0

    return norm(smooth(score + density * 0.6, 5))


# --------------------------------------------------------------------- audio
def audio_score(video, n_sec):
    """RMS loudness envelope per second, via raw PCM from ffmpeg."""
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", video, "-vn", "-ac", "1",
         "-ar", str(AUDIO_HZ), "-f", "s16le", "-"],
        capture_output=True)
    if not p.stdout:
        return np.zeros(n_sec)

    pcm = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32)
    usable = (len(pcm) // AUDIO_HZ) * AUDIO_HZ
    if usable == 0:
        return np.zeros(n_sec)
    frames = pcm[:usable].reshape(-1, AUDIO_HZ)
    rms = np.sqrt((frames ** 2).mean(axis=1))

    out = np.zeros(n_sec)
    take = min(n_sec, len(rms))
    out[:take] = rms[:take]

    # Reward CHANGE as well as level - a sudden jump is a reaction.
    delta = np.diff(out, prepend=out[0])
    return norm(smooth(norm(out) + norm(np.maximum(delta, 0)) * 0.8, 3))


# --------------------------------------------------------------------- scene
def scene_score(video, n_sec, threshold=0.3):
    """Shot-change density, measured on a cheap low-res / low-fps proxy."""
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", video,
         "-vf", f"fps=4,scale=160:-2,select='gt(scene,{threshold})',"
                f"metadata=print:file=-",
         "-an", "-f", "null", "-"],
        capture_output=True, text=True)

    score = np.zeros(n_sec)
    for m in re.finditer(r"pts_time:([0-9.]+)", p.stdout or ""):
        i = int(float(m.group(1)))
        if 0 <= i < n_sec:
            score[i] += 1.0
    return norm(smooth(score, 5))


# ------------------------------------------------------------------- helpers
def smooth(a, win):
    if win <= 1 or len(a) < win:
        return a
    k = np.ones(win) / win
    return np.convolve(a, k, mode="same")


def norm(a):
    lo, hi = float(a.min()), float(a.max())
    return (a - lo) / (hi - lo) if hi > lo else np.zeros_like(a)


def speech_gaps(words, min_gap=0.6):
    """Times where speech pauses - candidate cut points."""
    times = [t for t, _ in words]
    return [b for a, b in zip(times, times[1:]) if (b - a) >= min_gap]


def sentence_ends(words, min_gap=0.25):
    """Times just after a word that ENDS a sentence.

    Much better cut points than bare pauses: people pause mid-thought all the
    time, so gap-only snapping still lands mid-sentence. Whisper and YouTube
    captions both carry punctuation, so use it.
    """
    out = []
    for i, (t, w) in enumerate(words):
        if not w.rstrip().endswith(('.', '?', '!')):
            continue
        nxt = words[i + 1][0] if i + 1 < len(words) else t + 0.8
        if nxt - t >= min_gap:
            out.append(nxt)
        else:
            out.append(t + 0.35)     # tight cut, still after the full word
    return out


def snap_start(ends, gaps, target, window=6.0):
    """Open on a fresh sentence: prefer the last sentence end at/before target,
    then any pause, then give up and use the raw time."""
    cands = [g for g in ends if target - window <= g <= target + 1.5]
    if cands:
        return min(cands, key=lambda g: abs(g - target))
    cands = [g for g in gaps if target - window <= g <= target + 1.0]
    return min(cands, key=lambda g: abs(g - target)) if cands else target


def snap_end(ends, gaps, target, hard_max, window=18.0):
    """Never cut mid-sentence.

    Runs ON past `target` to the next SENTENCE END - a clip that runs a few
    seconds long is fine, one that stops mid-thought is not. Only falls back to
    a plain pause if no sentence end exists before the hard duration cap.
    """
    limit = min(target + window, hard_max)
    cands = [g for g in ends if target <= g <= limit]
    if cands:
        return min(cands)
    cands = [g for g in gaps if target <= g <= limit]
    if cands:
        return max(cands)            # the latest pause, not the earliest
    return target


def pick_clips(score, words, total, max_clips, min_clips):
    """Greedy non-overlapping selection around the highest-scoring seconds."""
    order = np.argsort(score)[::-1]
    gaps = speech_gaps(words)
    ends = sentence_ends(words)
    chosen = []

    for idx in order:
        if len(chosen) >= max_clips:
            break
        peak = float(idx)
        start = max(0.0, peak - LEAD_IN)
        end = min(total, start + LEAD_IN + LEAD_OUT)

        # Snap to natural speech boundaries so clips open and close on a thought,
        # instead of every clip being an identical fixed-length block.
        if gaps or ends:
            start = max(0.0, snap_start(ends, gaps, start))
            end = min(total, snap_end(ends, gaps, max(end, start + MIN_DUR),
                                      start + MAX_DUR))

        if end - start < MIN_DUR:
            end = min(total, start + MIN_DUR)
        if end - start < MIN_DUR:
            continue
        if end - start > MAX_DUR:
            end = start + MAX_DUR
        if any(not (end <= c["start"] or start >= c["end"]) for c in chosen):
            continue
        chosen.append({
            "start": round(start, 2),
            "end": round(end, 2),
            "duration": round(end - start, 2),
            "score": round(float(score[idx]), 4),
            "peak_at": round(peak, 2),
            "text": clip_text(words, start, end),
        })

    chosen.sort(key=lambda c: -c["score"])
    return chosen[:max_clips] if len(chosen) >= min_clips else chosen


def clip_text(words, start, end):
    got = [w for t, w in words if start <= t <= end]
    return " ".join(got)[:300]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--captions", help="YouTube json3 captions file")
    ap.add_argument("--profile", choices=list(PROFILES), default="balanced")
    ap.add_argument("--max-clips", type=int, default=MAX_CLIPS)
    ap.add_argument("--min-clips", type=int, default=MIN_CLIPS)
    ap.add_argument("--out", default="clips.json")
    ap.add_argument("--no-scene", action="store_true", help="skip scene detection (faster)")
    a = ap.parse_args()

    total = duration_of(a.video)
    n_sec = int(total) + 1
    wt, wa, ws = PROFILES[a.profile]

    words = load_words(a.captions) if a.captions and os.path.exists(a.captions) else []
    print(f"[score] {total:.0f}s video, {len(words)} caption words, "
          f"profile={a.profile}", file=sys.stderr)

    ts = transcript_score(words, n_sec) if words else np.zeros(n_sec)
    print("[score] transcript done", file=sys.stderr)
    aus = audio_score(a.video, n_sec)
    print("[score] audio done", file=sys.stderr)
    scs = np.zeros(n_sec) if a.no_scene else scene_score(a.video, n_sec)
    print("[score] scene done", file=sys.stderr)

    if not words:            # no transcript: redistribute its weight to audio
        wa += wt
        wt = 0.0

    combined = norm(wt * ts + wa * aus + ws * scs)
    clips = pick_clips(combined, words, total, a.max_clips, a.min_clips)

    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump({"video": a.video, "profile": a.profile,
                   "duration": total, "clips": clips}, fh, indent=2)

    print(f"[score] {len(clips)} clips -> {a.out}", file=sys.stderr)
    for c in clips[:10]:
        print(f"  {c['start']:8.1f}-{c['end']:<8.1f} score={c['score']:.3f}  "
              f"{c['text'][:60]}")


if __name__ == "__main__":
    main()
