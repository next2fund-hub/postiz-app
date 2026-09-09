#!/usr/bin/env python3
"""
pick_moments.py - let Claude choose the clips by actually reading the transcript.

The heuristic scorer (score_moments.py) counts question marks, hook words, audio
peaks and scene changes. It finds moments that LOOK eventful. It has no idea
whether anything interesting was said, and it cannot tell where a conversation
starts or finishes - which is why clips kept opening mid-thought and stopping
before the payoff.

This asks Claude to read the transcript and return COMPLETE exchanges: setup
through punchline, question through answer through reaction.

Cost: a 26-minute transcript is ~10k input tokens and ~2k output.
      Claude Opus 5 is $5/MTok in, $25/MTok out -> ~$0.10 per video,
      ~$0.05 on the Batch API. Twenty videos a month is a dollar or two.

Usage:
  python pick_moments.py --captions subs.json3 --duration 1559 --out clips.json
  python pick_moments.py --captions subs.json3 --duration 1559 --max-clips 20 \
      --min-dur 15 --max-dur 60 --context "gaming panel show"
"""

import argparse
import json
import os
import re
import sys

MODEL = "claude-opus-5"
SECRETS = r"C:\Users\Brian\.secrets\content.env"


def load_key():
    k = os.environ.get("ANTHROPIC_API_KEY")
    if k:
        return k.strip()
    if os.path.exists(SECRETS):
        with open(SECRETS, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("ANTHROPIC_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def load_words(path):
    """YouTube json3 (or our Whisper output, which mimics it)."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    out = []
    for ev in data.get("events", []):
        for s in ev.get("segs") or []:
            txt = s.get("utf8", "").strip()
            if txt:
                out.append(((ev.get("tStartMs", 0) + s.get("tOffsetMs", 0)) / 1000.0,
                            txt))
    out.sort(key=lambda x: x[0])
    return out


def to_lines(words, max_gap=0.8, max_words=18):
    """Group words into timestamped lines Claude can reference precisely."""
    lines, cur, start = [], [], None
    for i, (t, w) in enumerate(words):
        if start is None:
            start = t
        cur.append(w)
        nxt = words[i + 1][0] if i + 1 < len(words) else t + 1.0
        ends = w.rstrip().endswith((".", "?", "!"))
        if ends or (nxt - t) > max_gap or len(cur) >= max_words:
            lines.append((start, t, " ".join(cur)))
            cur, start = [], None
    if cur:
        lines.append((start, words[-1][0], " ".join(cur)))
    return lines


PROMPT = """You are choosing clips from a long video for short-form social media
(TikTok, Reels, YouTube Shorts).

Below is the transcript as timestamped lines: [start-end] text

{context_line}
Pick the {n} best moments to clip.

What makes a good clip:
- A COMPLETE exchange. If it is a question, include the full answer and any
  reaction. If it is a story, include the setup and the payoff. A clip that
  stops before the punchline is worthless.
- It must make sense to someone who has not seen the rest of the video. No
  dangling pronouns referring to something said ten minutes earlier.
- It opens on something that earns attention in the first two seconds - a
  question, a claim, a reveal, conflict, a strong opinion, a number.
- Genuine substance: an argument, a confession, a funny beat, a surprising
  fact, a disagreement. Not filler, logistics, or small talk.

Rules:
- Duration must be between {min_dur} and {max_dur} seconds. Prefer running a few
  seconds LONG to finish a thought rather than cutting it off.
- start must be the beginning of the first line of the exchange.
- end must be the end of the last line, AFTER the payoff or reaction lands.
- Clips must not overlap.
- Spread them across the video; do not take everything from one stretch.
- If fewer than {n} moments are genuinely worth clipping, return fewer. Do not
  pad with weak ones.

Return ONLY a JSON object, no prose, no markdown fence:

{{"clips": [
  {{"start": 123.4, "end": 145.2, "title": "short hook-style title",
    "reason": "one sentence on why this works as a clip",
    "score": 0.0}}
]}}

score is your confidence from 0 to 1, best first.

TRANSCRIPT:
{transcript}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--captions", required=True)
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--out", default="clips.json")
    ap.add_argument("--max-clips", type=int, default=20)
    ap.add_argument("--min-dur", type=float, default=15.0)
    ap.add_argument("--max-dur", type=float, default=60.0)
    ap.add_argument("--context", default="", help="what the video is, if known")
    ap.add_argument("--model", default=MODEL)
    a = ap.parse_args()

    key = load_key()
    if not key:
        sys.exit("no ANTHROPIC_API_KEY (env or secrets file)")

    words = load_words(a.captions)
    if not words:
        sys.exit("no words in transcript")
    lines = to_lines(words)
    transcript = "\n".join(f"[{s:.1f}-{e:.1f}] {t}" for s, e, t in lines)

    prompt = PROMPT.format(
        n=a.max_clips, min_dur=a.min_dur, max_dur=a.max_dur,
        transcript=transcript,
        context_line=f"Context: {a.context}\n" if a.context else "")

    import anthropic
    client = anthropic.Anthropic(api_key=key)

    print(f"[pick] {len(lines)} lines -> {a.model}", file=sys.stderr, flush=True)
    # Stream: adaptive thinking plus a long transcript can exceed the
    # non-streaming HTTP timeout.
    with client.messages.stream(
        model=a.model,
        max_tokens=16000,
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        msg = stream.get_final_message()

    if getattr(msg, "stop_reason", None) == "refusal":
        sys.exit(f"model declined: {getattr(msg, 'stop_details', None)}")

    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        sys.exit(f"no JSON in response:\n{text[:600]}")
    data = json.loads(m.group(0))

    clips = []
    for c in data.get("clips", []):
        st, en = float(c["start"]), float(c["end"])
        st = max(0.0, st)
        en = min(a.duration, en)
        if en - st < a.min_dur or en - st > a.max_dur + 5:
            continue
        clips.append({
            "start": round(st, 2), "end": round(en, 2),
            "duration": round(en - st, 2),
            "score": float(c.get("score", 0)),
            "title": c.get("title", ""),
            "reason": c.get("reason", ""),
            "text": " ".join(t for s, e, t in lines if st <= s <= en)[:300],
        })
    clips.sort(key=lambda c: -c["score"])
    clips = clips[:a.max_clips]

    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump({"engine": "claude", "model": a.model,
                   "duration": a.duration, "clips": clips}, fh, indent=2)

    u = msg.usage
    print(f"[pick] {len(clips)} clips | in {u.input_tokens} out {u.output_tokens} "
          f"tok (~${u.input_tokens/1e6*5 + u.output_tokens/1e6*25:.3f})",
          file=sys.stderr)
    for c in clips[:8]:
        print(f"  {c['start']:7.1f}-{c['end']:<7.1f} {c['duration']:5.1f}s "
              f"{c['score']:.2f}  {c['title'][:52]}")


if __name__ == "__main__":
    main()
