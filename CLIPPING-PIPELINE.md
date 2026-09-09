# Video Clipping Pipeline — spec + constraints

User-supplied spec (2026-09-07), with engineering constraints added.

## Target pipeline

 1. User uploads a file OR pastes a YouTube/Vimeo link
 2. Download with yt-dlp
 3. Extract audio + video streams with ffmpeg
 4. Whisper on the audio -> transcript + word timestamps
 5. Analyse transcript for clip candidates:
      - question marks (engagement hooks)
      - topic shifts (new clip opportunity)
      - repeated words / emphasis (energy peaks)
 6. Scene detection (ffmpeg scene filter, optionally OpenCV keyframes)
 7. Score moments = transcript score + scene score
 8. Build clip list: start 5s before peak, end 10-15s after, 15-60s total
 9. Per clip: cut with ffmpeg, burn in captions, resize to 9:16, pad background
10. Deliver clips (into the Postiz Media library, and/or ZIP download)

Stack (all free / open source):
  download     yt-dlp
  audio/video  ffmpeg            (INSTALLED LOCALLY: 8.1.2 full build)
  transcribe   Whisper           (prefer whisper.cpp -- see constraints)
  scenes       ffmpeg scene filter (+ OpenCV only if truly needed)
  scoring      Anthropic API, or regex/NLP heuristics
  captions     Whisper output -> SRT (pysrt)
  encode       ffmpeg

## THREE HARD CONSTRAINTS (found before building)

### 1. yt-dlp is blocked from datacenter IPs  <-- near-blocker
YouTube blocks cloud IPs (Railway/AWS/GCP) with "Sign in to confirm you're not
a bot". Works fine from a residential connection. ANY design that downloads
YouTube server-side is fragile from day one.
  -> Mitigation: run downloads on the local machine, and/or support DIRECT FILE
     UPLOAD, which avoids the problem entirely.

### 2. Whisper on Railway CPU is slow and is the dominant cost
No GPU on Railway. Even faster-whisper runs ~1-3x realtime on CPU, so a 1-hour
video pegs a core for 20-60 minutes. Railway bills $20/vCPU-month.
  -> Transcription would become the single largest line item.
  -> Local machine is Python 3.14 (very new); torch / faster-whisper wheels may
     not exist for it. whisper.cpp avoids Python entirely -- prefer it.

### 3. OOM risk
Video processing + a Whisper model in the SAME container as the app is exactly
how the earlier crash loop happened (see RAILWAY-DEPLOY.md Bug 1/Bug 4).
  -> Must be a separate service with headroom, never the `postiz` container.

## RECOMMENDED ARCHITECTURE — hybrid

Keep the Studio UI in Postiz. Run the heavy work locally.

  Browser (Postiz /studio)  ->  job queued in Postiz
  local agent on the PC polls for jobs
  yt-dlp + ffmpeg + whisper.cpp   (free CPU, residential IP)
  uploads finished clips -> R2 -> Media library
  clips appear in Postiz ready to schedule

  PRO: in-UI experience preserved; $0 extra Railway CPU; no YouTube IP blocking;
       no OOM risk to the live app.
  CON: the PC must be on for jobs to run. Fine for batch work like clipping.

  ALTERNATIVE (all on Railway): works unattended from anywhere, but expect
  $25-60/month CPU and ongoing YouTube blocking issues.

## Notes
- Keep LONG-FORM SOURCE video local/temp and delete after clipping. A 1-hour
  1080p file is 1-3 GB and would blow the R2 free tier (see TODO.md STORAGE).
- ffmpeg's scene filter handles most shot-change detection; add OpenCV only if
  it proves insufficient (it is a heavy dependency and bloats the image).
- Downloading third-party YouTube content is against YouTube's ToS. Clipping
  your OWN long-form uploads is the intended use here.

## FINALISED OUTPUT PARAMETERS (user, 2026-09-07)

  Clips per source video : 5 to 20
  Clip duration          : 15 to 60 seconds
  Audio                  : preserved
  Captions               : burned in (from Whisper word timestamps)
  Format                 : 9:16 vertical (pad/blur background as needed)

Selection rule: score-THRESHOLD is the real filter, N is a safety cap.
  - take every moment above the quality threshold
  - hard cap at 20 (never flood the Media library from a long stream)
  - if fewer than 5 clear the threshold, take the top 5 anyway
This avoids both "80 mediocre clips from a 3.5h stream" and "only 2 clips from
a video that had 10 good moments".

## SCORING SIGNALS — weight by content type

Three independent signals, combined:

  1. TRANSCRIPT (Whisper)   question marks, topic shifts, repeated words /
                            emphasis, story beats
  2. SCENE CHANGES          ffmpeg scene filter (shot cuts, visual activity)
  3. AUDIO ENERGY           ffmpeg ebur128 / astats loudness envelope --
                            laughter, shouting, crowd reaction, pacing spikes
                            (NO extra dependency, ffmpeg already does this)

WEIGHTING MATTERS AND SHOULD BE PER CONTENT TYPE:
  - talking-head / podcast / own long-form -> TRANSCRIPT signals dominate
  - reaction / gaming / live stream        -> AUDIO ENERGY dominates
    (verbal cues are sparse; the signal is in the waveform)

Build the weights as config so a content-type preset can be chosen per job.

## REFERENCE TEST CASE (verified 2026-09-07)

  URL      https://www.youtube.com/watch?v=4zVFht1KbnY
  Title    WORLD TALENT SHOW
  Channel  IShowSpeed  (THIRD-PARTY -- not the user's own content)
  Duration 12495 s = 3 h 28 m
  Res      1920x1080

yt-dlp 2026.08.19 installed locally via pip; metadata extraction from this
machine SUCCEEDED with no bot check -> the residential/local path works.
(pip warning: yt-dlp.exe is in %APPDATA%\Python\Python314\Scripts which is not
on PATH -- invoke as `python -m yt_dlp`.)

Sizing for a source this long: ~3-6 GB download; Whisper 30 min - 3 h on CPU.
One video is a MULTI-HOUR job -> needs progress reporting, resumability, and
must never block the UI.

## COST CORRECTION (supersedes the $25-60/mo figure above)

Railway bills CPU per MINUTE of actual use: $20/vCPU-month = ~$0.027/vCPU-hour.
So ~3 CPU-hours per video is about $0.08. Twenty videos/month is under $2 of
compute, plus ~$5-10/month baseline for an idle service.

=> RAILWAY CPU IS NOT THE REASON TO GO LOCAL.
The real reasons are narrower:
  - YouTube IP blocking (affects the yt-dlp path ONLY)
  - 3-6 GB per source video moving through Railway
  - OOM risk if it shares the app container

## COMPETITIVE COMPARISON (researched 2026-09-07)

Reference tools the user named. TWO of the four are not clippers at all:

  Ssemble   ssemble.com   TRUE CLIPPER. $6-24/mo. 1 credit = 20 min of video.
  Snazo     snazo.app     TRUE CLIPPER. from $9.99/mo. ~10 clips in ~1 min.
  Viewmax   viewmax.io    AI video GENERATION (scripts, voiceover, UGC). Not clipping.
  Higgsfield higgsfield.ai AI generation suite (Seedance 2.5, Nano Banana Pro).
                          NO clipping features at all.

=> Benchmark the clipper against SSEMBLE and SNAZO only.
   Viewmax / Higgsfield map to the STUDIO'S "Video Generator" card instead.

CONCEPT MATCHES: ingest -> transcribe -> detect -> score -> cut -> caption ->
9:16 -> publish. Snazo describes the same loop ("finds hooks, reframes to 9:16,
captions every word, paces each cut for watch time").

### GAPS in our spec vs the commercial tools -- ADD THESE

1. FACE TRACKING / AUTO-REFRAME  <-- biggest quality gap
   Our spec says "resize to 9:16, add padding/background" = letterboxing.
   Ssemble does FACE DETECTION to keep the speaker centred, plus a Sports Mode
   that tracks the ball instead of faces.
   A static crop with blurred bars looks visibly amateur beside a tracked crop.
   -> Needs OpenCV face detection + a SMOOTHED crop path (avoid jitter).
      This is the one place OpenCV genuinely earns its dependency weight.

2. WORD-LEVEL ANIMATED CAPTIONS
   Snazo "captions every word" (TikTok karaoke-style highlight).
   Whisper already returns word timestamps, so the data exists -- this is a
   RENDERING choice: generate ASS subtitles and burn with ffmpeg, not flat SRT.
   Static SRT blocks look dated.

3. HOOK TITLES + CTA generation
   Ssemble auto-generates both per clip. Cheap to add via the Anthropic API
   that is already in the Studio plan.

4. SPEED EXPECTATIONS
   Snazo: ~10 clips in ~1 minute, on GPU infrastructure.
   Our CPU pipeline on a 3.5 h source takes HOURS.
   Not a flaw -- but design for BATCH-AND-NOTIFY, never watch-and-wait.

5. CHANNEL AUTOMATION (later)
   Ssemble monitors a YouTube channel, auto-clips new uploads, auto-posts.
   Natural extension since Postiz already handles scheduling.

Also worth having: multi-language captions / translation (Whisper supports it).

### HONEST BUILD-VS-BUY NOTE
For PURE CLIPPING, Snazo at $9.99/mo undercuts the cost of building and
maintaining this. The legitimate reasons to build are the ones the user gave:
everything in ONE platform, no per-credit ceilings, and owning the pipeline.

## BUILT + VERIFIED 2026-09-07 — tools/autoreframe.py

Face-tracking vertical reframe. WORKING on real footage.

Environment verified on this machine:
  Python 3.14.3 | OpenCV 5.0.0 | NumPy 2.5.3 | ffmpeg 8.1.2 | yt-dlp 2026.08.19
  (OpenCV 5 no longer ships Haar cascades -- cv2.data.haarcascades is EMPTY.
   Use cv2.FaceDetectorYN (YuNet). Model vendored at
   tools/models/face_detection_yunet_2023mar.onnx, 227 KB, from opencv_zoo.)

Architecture: TWO PASSES
  1. ANALYSE - decode, detect faces with YuNet, build a smoothed crop path
  2. RENDER  - drive ffmpeg's crop filter via a sendcmd file, so ALL encoding
               stays in ffmpeg. Fast, good quality, audio preserved for free.
               (Do NOT pipe raw frames through Python -- far slower.)

Quality controls in the analysis pass (this is what separates it from a static
centre crop):
  - median filter      kills single-frame detection spikes
  - forward+backward EMA  smooths with ZERO phase lag (camera never trails)
  - deadzone           holds still until real drift (anti-jitter)
  - speaker hysteresis a rival face must be 1.35x larger to steal focus,
                       so it does not flap between two people
  - bounds clamping    crop window never leaves the frame
  - centre-crop fallback when no face is found anywhere

### PERFORMANCE FIX (important)
First version seeked per sample: cap.set(CAP_PROP_POS_MSEC) for every sample.
On a 75-minute file that is catastrophic -- 127 s to process a 30 s clip (4x
REALTIME). Fixed by seeking ONCE then decoding sequentially, running detection
only every Nth frame:
      127 s  ->  26 s     (4.9x faster, now FASTER than realtime)
Also improved temporal resolution: 71 -> 105 crop updates over the same 30 s.

### Verified output
  source 854x480 -> crop 270x480 -> output 1080x1920 h264 + aac
  Real 9:16 crops that follow the subject. No letterbox, no blur bars.
  Frames inspected: tight single-subject framing, sensible group framing.

## INGEST: THE BIG FINDING (2026-09-07)

Answering "why are the commercial platforms so fast" -- it is the SEEK
STRATEGY, not bandwidth and not YouTube.

Measured on https://www.youtube.com/watch?v=s0r7eNZqnY0 (75 min, 4K source):

  yt-dlp --download-sections "*600-640"        >9 MINUTES, then timed out
  (same job left to run to completion)        616 KB in 1 h 16 min
                                              = 137 BYTES PER SECOND
  (a second such job, on the 3.5 h video)     632 KB in 4 h 44 min
                                              = 37.96 BYTES PER SECOND
  Full download of the SAME source: 13 s at 34.7 MB/s.
  That is roughly a MILLION-FOLD throughput difference. --download-sections is
  not "slower", it is unusable.
  yt-dlp -N 16 + --download-sections           NO IMPROVEMENT
  yt-dlp -N 16, FULL file (480p, 413 MB)       13 SECONDS at 34.7 MiB/s

=> Downloading the ENTIRE 75-minute video is ~40x FASTER than extracting 40
   seconds from it.

WHY: --download-sections routes through the FFMPEG downloader, which uses a
SINGLE connection and SILENTLY IGNORES -N / --concurrent-fragments. YouTube
throttles per connection. The native downloader with -N 16 pulls many DASH
fragments in parallel and saturates the link.

RULE FOR THE PIPELINE:
  DOWNLOAD THE WHOLE FILE ONCE with -N 16, then cut all 5-20 clips LOCALLY
  with ffmpeg. One throttled negotiation instead of twenty.
  NEVER use --download-sections for multi-clip jobs.

### Other speedups the commercial tools use (all free, adopt them)
  - ANALYSE ON A LOW-RES PROXY. Detect faces on a 360p version, then apply the
    crop to the high-res source -- crop coordinates scale perfectly. On a 4K
    source this is the difference between hours and minutes.
  - GPU ENCODING. Swap libx264 -> h264_nvenc if an NVIDIA GPU is present
    (~10x faster rendering). ffmpeg here is a full build so nvenc is available.
  - What we CANNOT match for free: residential proxy pools, which is how they
    keep download speed consistent at scale.

## WHISPER — VERIFIED WORKING 2026-09-07

faster-whisper INSTALLS AND RUNS on Python 3.14 (ctranslate2 4.8.2).
No torch needed. whisper.cpp NOT required.

    pip install faster-whisper
    WhisperModel(name, device='cpu', compute_type='int8')
    transcribe(path, word_timestamps=True, vad_filter=True)

WORD-LEVEL TIMESTAMPS CONFIRMED -- this is what karaoke/animated captions need:
    0.00-0.72 'I'   0.72-0.88 'just'   0.88-1.10 'wish'
VAD filter works. Language auto-detect returned en @ 1.00 confidence.

### Benchmarks (CPU, int8, 60 s of real audio from the test video)

    base   9.4 s   6.41x realtime   ->  ~12 min for the 75-min source
    small 22.9 s   2.62x realtime   ->  ~29 min for the 75-min source

Accuracy difference is REAL and visible:
    base :  "I'll be all good."
    small:  "I hope you're all good."      <- correct

### TWO-TIER STRATEGY (adopt this)
  1. FULL VIDEO with `base` -> moment scoring only.
     Scoring needs topic shifts / questions / energy, NOT perfect words.  ~12 min
  2. SELECTED CLIPS ONLY with `small` (or medium) -> burned-in captions.
     20 clips x 30 s = 10 min of audio, not 75.                            ~4 min
  TOTAL ~16 min with high-accuracy captions, vs ~29 min running small on
  everything. Captions are the visible artifact, so they get the good model.

### Revised end-to-end estimate for a 75-min 4K source (this machine)
    download full file, -N 16 ............  13 s
    transcribe full, base ................ ~12 min
    scene + energy analysis .............. minutes
    re-transcribe selected clips, small ... ~4 min
    reframe + render 20 clips ............ ~26 s per 30 s clip (CPU x264)
                                            -> ~9 min, LESS with nvenc
    ============================================================
    roughly 25-30 minutes for a full 75-minute source, on CPU.
Earlier "hours" estimate was WRONG -- it assumed per-sample seeking and
running the large model across the whole file.

## SPEED BREAKTHROUGH 2026-09-07 — skip Whisper entirely for YouTube sources

USE YOUTUBE'S OWN AUTO-CAPTIONS. They include WORD-LEVEL TIMESTAMPS.

    yt-dlp --skip-download --write-auto-sub --sub-lang en --sub-format json3 URL

Measured on the 75-minute test video:
    caption download ............ 7 SECONDS      (1.72 MB, 10,796 word tokens)
    vs Whisper base full pass ... ~12 MINUTES
=> ~100x faster, and it is the SAME data the scorer needs.

json3 structure: events[] -> segs[], each seg has utf8 + tOffsetMs, event has
tStartMs. Word time = (tStartMs + tOffsetMs)/1000. Verified:
    1.70s 'To '   2.26s 'everyone,'   2.31s ' Back'

Auto-captions exist for essentially every YouTube video, in many languages
(the test video listed 100+ auto-translated languages).

WHEN WHISPER IS STILL NEEDED:
  - user-uploaded files (no YouTube captions exist)
  - when caption quality is visibly poor and burned-in captions must be perfect
  - non-YouTube sources
  Keep faster-whisper as the FALLBACK path, not the default.

## GPU ENCODING — available but BLOCKED on a driver update

  GPU: NVIDIA GeForce GTX 1060 3GB
  Driver: 566.36
  ffmpeg h264_nvenc requires: 610.00 or newer

  ERROR: "The minimum required Nvidia driver for nvenc is 610.00 or newer"
  -> produces a 0-byte output file, FAILS SILENTLY unless stderr is checked.

  ACTION: update the NVIDIA driver, then use --encoder nvenc.
  autoreframe.py already supports --encoder x264|nvenc.
  No AMD AMF (h264_amf fails). Intel QSV inconclusive.

## REVISED END-TO-END ESTIMATE — 75-min YouTube source

    download full video (-N 16) ........ 13 s
    download word-level captions ....... 7 s
    transcription ...................... 0  (using YouTube captions)
    scene + audio-energy analysis ...... minutes (ffmpeg, low-res proxy)
    face-track + render, 20 x 30 s clips
        CPU x264, sequential ........... ~8 min   (25 s per clip, measured)
        CPU x264, 4 clips in parallel ... ~2-3 min (4 logical cores)
        GPU nvenc (after driver update) . ~2 min
    ==================================================================
    REALISTIC TOTAL: ~5-8 min on CPU with parallelism
                     ~3-4 min once nvenc works
    (was 25-30 min before these findings)

Snazo does ~1 min on GPU cloud infrastructure. 3-8 minutes locally, with no
per-clip credits and no subscription, is a fair trade.

### Remaining speedups not yet applied
  - PARALLEL CLIP RENDERING across cores (only 4 logical cores here, so
    3 concurrent renders is about the practical limit)
  - LOW-RES PROXY for face detection on 4K sources: detect on 480p, apply the
    crop to the 4K master. Crop coordinates scale linearly.
  - Only decode the SPANS that become clips, not the whole file, once the clip
    list is known.

## PERFORMANCE TUNING RESULTS 2026-09-07 (all measured, 30 s clip)

### 1. NVENC IS NOT AVAILABLE ON THIS MACHINE
  GPU: GTX 1060 3GB (Pascal, 2016).  Driver updated 566.36 -> 582.66.
  STILL FAILS: "Driver does not support the required nvenc API version.
                Required: 13.1  Found: 13.0"
  ffmpeg 8.1.2 needs driver 610.00+. Pascal is on NVIDIA legacy support, so
  610+ may never ship for this card.
  NOTE: nvenc failure writes a 0-BYTE FILE AND EXITS 0 unless stderr is read.
        Always check output size.
  Options: install an older ffmpeg (7.x, targets nvenc API 13.0), or skip GPU.

### 2. PARALLEL RENDERING BARELY HELPS (only 4 logical cores)
  3 clips sequential : 70 s
  3 clips parallel   : 57 s      = just 1.23x
  x264 is already multi-threaded, so parallel jobs just contend for the same
  4 cores. Do NOT expect linear scaling from parallelism on this machine.

### 3. *** AVOID AV1. FORCE H.264 AT DOWNLOAD. ***  <-- biggest free win
  yt-dlp's default "best" picked an AV1 stream. AV1 decode is very slow on CPU.

      av1  : analyse 12.9 s | render 14.5 s | TOTAL 27.4 s
      h264 : analyse  5.0 s | render 12.3 s | TOTAL 17.3 s

  => 2.6x faster ANALYSIS, 1.6x faster overall, for a format-selector change:
      -f "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080]"

### 4. x264 PRESET (render only, 30 s clip)
      veryfast   11.1 s   12.4 MB     <- good default
      faster     19.9 s   14.9 MB     (slower than veryfast; x264 preset order)
      ultrafast   4.3 s   32.4 MB     <- 2.6x faster, 2.6x bigger
  Keep veryfast as default. Offer ultrafast as an opt-in "fast mode".
  Size matters: 20 clips is 250 MB at veryfast vs 640 MB at ultrafast, against
  R2's 10 GB free tier.

### 5. Where the time actually goes (h264 source, 30 s clip)
      analyse 5.0 s   (OpenCV decodes EVERY frame, detects on every 5th)
      render 11-12 s
  NEXT OPTIMISATION: stop decoding every frame in OpenCV. Pipe only the sampled
  frames from ffmpeg at low res:
      ffmpeg -ss X -t D -i in.mp4 -vf fps=6,scale=480:-1 -f rawvideo -
  Decodes 180 frames instead of 900, and shrinks them for detection. Should cut
  the analyse pass substantially, especially on 4K sources.

## FINAL REALISTIC TIMELINE — 75-min YouTube source, this machine
    download full file, H.264, -N 16 ....... 14 s
    download word-level captions ........... 7 s
    transcription .......................... 0
    scene + energy analysis ................ ~minutes
    20 clips x (5 s analyse + 11 s render) . ~5.3 min sequential
                                             ~4.3 min with parallelism
    ================================================================
    TOTAL ~6-8 MINUTES     (was 25-30 min at the start of this session)

## *** NVENC SOLVED WITHOUT NEW HARDWARE (2026-09-07) ***

The blocker was NEVER the GPU -- it was an ffmpeg/driver API MISMATCH.

  GTX 1060 (Pascal) + driver 582.66  -> provides NVENC API 13.0
  ffmpeg 8.1.2                        -> demands  NVENC API 13.1 (driver 610+)

Pascal will NEVER reach 610: R580 is the LAST driver branch for Maxwell/Pascal/
Volta; release 590 drops them entirely. No NVIDIA download can fix this, and the
Studio 581.57 driver is OLDER than what is already installed -- a downgrade.

FIX: use an ffmpeg 7.x binary, which targets NVENC API 13.0, ONLY for nvenc
renders. Everything else keeps using the system ffmpeg 8.1.2.

  Binary: tools/ffmpeg7/ffmpeg.exe   (ffmpeg n7.1.5, BtbN win64-gpl build)
  Source: github.com/BtbN/FFmpeg-Builds  release autobuild-2026-07-31-14-10
          asset ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1.zip
  autoreframe.py --encoder nvenc automatically uses it when present.

### Measured (30 s clip, 1080x1920 out)
  RENDER ONLY:
    libx264 veryfast crf20 .... 11.9 s   12.4 MB
    h264_nvenc p4 cq23 .........  3.0 s   23.5 MB   (4x faster, but bigger)
    h264_nvenc p5 cq26 .........  2.9 s   16.8 MB
    h264_nvenc p5 cq29 .........  3.0 s   11.9 MB   <-- MATCHES x264 SIZE
    h264_nvenc p5 cq32 .........  3.0 s    8.4 MB
  => p5 / cq29 chosen: same file size as x264 veryfast, 4x the speed.

  END TO END per clip (analyse + render):
    x264  ... 18 s   13.2 MB
    nvenc ... 10 s   13.0 MB

Analysis (~5 s) is now the DOMINANT cost, not encoding. Next optimisation is
the ffmpeg-piped low-res sampling for the analyse pass.

## FINAL PIPELINE TIMING — 75-min YouTube source, this machine, WITH nvenc
    download full file, H.264, -N 16 ....... 14 s
    download word-level captions ........... 7 s
    transcription .......................... 0
    scene + energy analysis ................ ~minutes
    20 clips x 10 s ........................ ~3.3 min
    ================================================================
    TOTAL ~4-5 MINUTES     (was 25-30 min at the start of this session)

GPU PURCHASE: NOT needed for encoding. An RTX 4060 Ti 16GB would still help
with (a) hardware AV1 DECODE, which Pascal lacks, and (b) CUDA Whisper for
user-uploaded files with no YouTube captions. Neither is urgent.

## ITEM 1 DONE — tools/score_moments.py (moment scorer)

Decides WHICH parts become clips. Three signals -> per-second score -> greedy
non-overlapping window selection.

  TRANSCRIPT  questions (+2.0), hook words (+1.0), shouted CAPS (+0.5),
              speech gaps as topic-shift markers (+1.0), word density
              Source: YouTube json3 captions. FREE, word-level, no Whisper.
  AUDIO       RMS envelope from raw PCM (ffmpeg -f s16le at 1 kHz) plus a
              bonus for POSITIVE DELTA -- a sudden jump is a reaction.
  SCENE       ffmpeg scene filter on a cheap fps=4, scale=160 proxy.

PROFILES (weights: transcript / audio / scene) -- signal lives in different
places depending on content:
  talking   0.55 / 0.25 / 0.20   podcasts, interviews, own long-form
  energy    0.20 / 0.60 / 0.20   reaction, gaming, live streams
  balanced  0.40 / 0.40 / 0.20
If no captions exist, the transcript weight is redistributed to audio.

### BOUNDARY SNAPPING (important quality fix)
First version produced clips of IDENTICAL length (17.0 s every time) because it
used fixed LEAD_IN/LEAD_OUT offsets. Real clips should start and end on a
thought. Now snaps to SPEECH GAPS (>=0.6 s pauses):
    before: every clip 17.0 s, text starts mid-sentence ("it? Are you crazy?")
    after : 16.4-23.5 s, mean 19.3 s ("Can you get it? Are you crazy?")

### Measured
  Scoring a 75-minute video: 63 SECONDS (transcript + audio + scene).

  python score_moments.py --video h264.mp4 --captions subs.en.json3 \
      --profile energy --max-clips 20 --out clips.json

Output JSON per clip: start, end, duration, score, peak_at, text.

## FACE-SIZE FILTER — tuning finding (real content only reveals this)

Rendering the top-scoring clip exposed the tracker locking onto a CARTOON FACE
DRAWN ON A CHALKBOARD. Technically a correct detection; wrong subject.

Added MIN_FACE_FRAC (ignore faces narrower than this fraction of frame width):
    0.045 -> filtered the drawing completely, BUT dropped real detections too:
             crop commands fell 105 -> 50 and the subject drifted to the frame
             edge. WORSE framing.
    0.028 -> real tracking preserved (98 commands, framing verified good),
             most tiny false positives rejected.            <-- CHOSEN

KNOWN LIMITATION: a drawn/printed face IS a face. Faces on posters, screens and
artwork can still be picked up. A proper fix needs PERSON/BODY detection rather
than face-only. Not worth it yet.

## ITEM 2 DONE — tools/captions.py (word-level animated captions)

Generates ASS subtitles where a short phrase is on screen and the CURRENTLY
SPOKEN word is highlighted (amber, scaled 108%). That per-word highlight is
what makes TikTok/Reels captions feel alive; flat SRT blocks look dated.

Word timings come FREE from the YouTube json3 captions - no Whisper.

BURNED IN DURING THE SAME ENCODE as the reframe:
    autoreframe.py --subs clip.ass
The .ass is copied into the ffmpeg tmpdir and referenced relatively, so the
filter path needs no Windows escaping (same trick as the sendcmd file).
One encode, no second pass, no extra generation loss.

    python captions.py --captions subs.en.json3 --start 246.7 --duration 19.5 \
        --out clip.ass [--font "Arial Black"] [--size 76] [--margin-v 420]

### THREE BUGS FOUND BY LOOKING AT RENDERED FRAMES
1. WrapStyle: 2 means NO WORD WRAPPING -> long phrases ran straight off the
   right edge of the frame. Must be WrapStyle: 0.
2. json3 "segments" ARE NOT ALWAYS SINGLE WORDS ("To detention" is one seg).
   Chunking by segment count overflowed the frame and highlighted whole
   phrases instead of words. Fix: split segs on whitespace and spread the
   segment's time span across the resulting words.
3. Some segments are PURE PUNCTUATION, producing a stray floating "?".
   Fix: drop segments with no alphanumeric character.

### Settings that matter
  MAX_CHARS = 26      real limit per phrase (character budget, not word count)
  MAX_WORDS = 4       upper bound on segments
  size      = 76      92 was too large for 1080 wide
  margin-v  = 420     keeps captions clear of platform UI overlays
  COL_ACTIVE = amber, COL_IDLE = white, thick black outline for readability

Verified on a real clip: single word highlighted, one line, no overflow,
no punctuation artefacts. Render with captions: ~6 s for a 19.5 s clip (nvenc).

## ITEM 3 DONE — tools/clip.py (end-to-end orchestrator)

One command: long video in, finished captioned vertical clips out.

    python clip.py --url "https://youtube.com/watch?v=..." --outdir out \
        --profile energy --max-clips 20 --encoder nvenc

    python clip.py --video local.mp4 --captions subs.json3 --outdir out

Pipeline: download -> captions -> score -> per-clip ASS -> reframe+burn -> manifest

PROGRESS IS EMITTED AS JSON LINES ON STDOUT so a worker or UI can drive a
progress bar; the human log goes to stderr. Stages: download, captions, score,
render (per clip, with index/total), complete.
This is the interface the local agent and the Studio page will consume.

Outputs in --outdir:
    source.mp4        downloaded source (kept for re-clipping without re-download)
    subs.en.json3     word-level captions
    clips.json        scorer output
    clip_NN.ass       per-clip captions
    clip_NN.mp4       finished vertical clip
    manifest.json     start/end/duration/score/file/bytes/render_seconds per clip

Download uses FULL FILE + -N 16 + FORCED H.264 (avc1). Never --download-sections.

### Measured — 5 clips from the 75-min source (nvenc)
    scoring ............. 62 s
    render per clip ..... 5.0-6.0 s  (16-21 s clips, 4.3-9.1 MB)
    TOTAL ............... 1.5 min

Verified by frame inspection: correct 9:16 framing, subject centred, per-word
caption highlight burned in.

## ITEM 4 DONE — tools/agent.py (job queue + local worker) — UPLOAD VERIFIED

    python agent.py --queue ./queue --work ./work           # run forever
    python agent.py --queue ./queue --work ./work --once    # single job
    python agent.py --queue ./queue --submit '{"url":"https://youtu.be/..."}'

Verified end to end 2026-09-07:
    [agent] watching ./queue  (Postiz upload: ON)
    [agent] score done (67.2s) -> clip 1 done -> clip 2 done
    [agent] uploaded 2/2
    [agent] OK

Job source is PLUGGABLE: DirectoryQueue today (JSON files, claimed by rename so
a crash leaves a visible .running file). Swap for an HttpQueue polling Postiz
when the Studio page ships -- nothing else in the agent changes.

Captures clip.py's stderr to <workdir>/<job>/stderr.log. The first version sent
it to DEVNULL and a failure reported only "no manifest produced", which is
undebuggable.

## POSTIZ PUBLIC API — VERIFIED WORKING 2026-09-07

Key from Settings > API (self-hosted gets tier ULTIMATE, so the tab IS shown).
Stored as POSTIZ_API_KEY in C:\Users\Brian\.secrets\content.env (64 chars).
Auth = RAW key in the Authorization header. NO "Bearer" prefix.

    GET  /api/public/v1/integrations   -> HTTP 200, 3 channels:
             instagram  Next2Fund | Business Funding Experts
             facebook   Next2Fund
             telegram   Next2Fund
    POST /api/public/v1/upload         -> HTTP 201 in 1 s for a 4.4 MB clip
             {"id":"...","name":"clip_01.mp4","path":"https://content.next2fund.com/uploads/..."}

### Postiz also exposes an MCP server
    https://content.next2fund.com/api/mcp/<API_KEY>
The key IS the auth (mounted at /mcp/:id -> getOrgByApiKey(req.params.id)).
Tools: integrationList, schedulePostTool, integrationSchema, triggerTool,
       generateImageTool, generateVideoTool, generateVideoOptions, videoFunctionTool

NOTE: there is NO upload tool in the MCP, so the agent still needs the REST
/upload endpoint. MCP is for a human driving Postiz from Claude; REST is for the
worker pushing files in.
The generate* MCP tools need OPENAI_API_KEY / a video provider, neither set here.
Add with --scope user, NEVER project scope: the URL embeds the API key and a
project .mcp.json would be committed to the fork.

## WHISPER FALLBACK ADDED 2026-09-08 (tools/transcribe.py)

FOUND BY RUNNING ON DIFFERENT CONTENT. A run on a FaZe video reported
"captions: NONE" and carried on silently. The cascade:

    no transcript -> no transcript scoring
                  -> NO SPEECH-GAP BOUNDARY SNAPPING, so EVERY CLIP CAME OUT
                     EXACTLY 17.0 s (the fixed LEAD_IN + LEAD_OUT)
                  -> NO BURNED-IN CAPTIONS

The video DID have captions. The real cause was:

    ERROR: Unable to download video subtitles for 'en': HTTP Error 429:
    Too Many Requests

i.e. we had hammered YouTube's caption endpoint during testing and got rate
limited. Silently degrading was the bug, not the 429.

### Fixes
1. tools/transcribe.py -- faster-whisper -> YOUTUBE json3-SHAPED output:
       {"events":[{"tStartMs":1700,"segs":[{"utf8":"word","tOffsetMs":0}]}]}
   Shaping it like json3 means score_moments.py and captions.py need NO
   special-casing for where the words came from.
2. clip.py falls back to Whisper automatically when captions are missing,
   for BOTH --url and --video inputs. Disable with --no-whisper;
   choose accuracy with --whisper-model base|small.
3. get_captions() now GLOBS `subs*.json3`. yt-dlp may write subs.en.json3,
   subs.en-orig.json3 or subs.en-US.json3, and guessing exact names would
   have failed even without the 429.
4. Caption failures are now LOGGED with the yt-dlp error tail instead of
   silently becoming "NONE".

### Measured, same 26-min 4K FaZe source
    YouTube captions ........ ~7 s      (when not rate limited)
    Whisper base ............ 518 s     3.0x realtime, 5905 words
  Whisper is a FALLBACK, not a default -- 74x slower than just fetching them.

    durations WITHOUT transcript:  17.0 17.0 17.0 17.0 17.0   <- the tell
    durations WITH transcript:     17.2 21.4 20.8 24.5 22.4

Verified by frame inspection: face tracking centred, word-level caption
highlight burned in.

THIS ALSO MAKES THE CLIPPER WORK ON YOUR OWN UPLOADS, which have no YouTube
captions at all and would previously have produced silent, fixed-length,
uncaptioned clips.

### STILL TO DO
- 4K sources are slow to analyse (render 16-20 s/clip vs ~10 s at 1080p)
  because OpenCV decodes full-resolution frames. Fix: detect faces on a
  low-res proxy and scale the crop coordinates up. Crop maths is linear.
- clip.py has NO GUARD against two runs sharing one --outdir. Doing so fails
  with "WinError 32 ... used by another process" during yt-dlp's
  source.temp.mp4 -> source.mp4 rename. agent.py is safe (work/<job-id>/).

## MOTION + BOUNDARY FIXES 2026-09-08 (found by watching real clips)

User feedback after watching output: "centering off", "image was shaking back
and forth", "cuts off mid sentence".

### 1. SHAKING -- two compounding bugs

(a) THE DEADZONE SNAPPED. Old code:
        if abs(v - cur) > dead: cur = v
    The instant drift exceeded the deadzone it TELEPORTED the crop by the full
    deadzone width in one sample. Now it EASES at a bounded speed, with
    hysteresis (start moving outside the deadzone, stop within 25% of it) so it
    does not stutter at the boundary.

(b) *** UNITS BUG: deadzone and pan speed were measured against SOURCE width,
    but what the viewer sees is the CROP WINDOW upscaled to 1080. ***
    On a 1920 source with a 607px crop that made both ~3x too large:

        deadzone  0.035 x 1920 = 67 src px  -> 120 px of 1080 output  (11%!)
        pan cap   0.10  x 1920 = 192 px/s   -> 341 px/s output (32%/sec!)

    It tolerated huge drift, then panned fast to catch up. MEASURED AFTER
    switching both to crop_w:

        pan     341 px/s (32%/s)  ->  108 px/s (10%/s)
        deadzone 120 px (11%)     ->   38 px (3.5%)

    ANY fraction affecting apparent motion must be relative to crop_w, NOT src_w.

(c) CMD_HZ 12 -> 25. ffmpeg's sendcmd sets crop x as a STEP function, so a low
    command rate makes every change a visible jump.

Also: SAMPLE_HZ 6 -> 8, EMA_ALPHA 0.12 -> 0.08, MEDIAN_WIN 5 -> 7.

### 2. CUTS OFF MID-SENTENCE
Snapping to ANY pause >= 0.6s was not enough -- people pause mid-thought
constantly, so clips still ended mid-sentence.

Now snaps to SENTENCE ENDS detected from punctuation (. ? !), which both
Whisper and YouTube captions carry. sentence_ends() returns the NEXT word's
start, so the sentence-final word is fully inside the clip.

snap_end() now RUNS ON up to 18s past the target to reach a sentence end
(user: "its okay if video runs a bit longer, must catch the whole sense").
Falls back to the LATEST pause in range, then to the raw time.
LEAD_OUT 12 -> 14.

RESULT on the test video: 0/5 clips ended cleanly -> 4/5. The 5th had no
sentence end within the window and fell back to a pause, as designed.

### VERIFICATION GOTCHA -- do not repeat this
Checking "does the clip end on a sentence" with `start <= t <= end` reports
FALSE CUTS. sentence_ends() returns the next word's START time, so a word
beginning exactly at the clip end gets counted as inside. Use `t < end - 0.05`.
Also note clips.json "text" is TRUNCATED TO 300 CHARS by clip_text(), so its
trailing "..." is a display artefact, NOT the clip boundary.

## ACTIVE SPEAKER DETECTION 2026-09-08 (the "swaying" fix)

User: "why is the swaggin side to side, the main person speaking is not focused"

DIAGNOSIS -- measured, not guessed. On the offending clip:
    faces per sample: min 3, max 6, mean 4.6
    samples with >1 face: 90/90
    face centres spread across x = 128 .. 1862 on a 1920 source

The tracker picked "biggest face, else nearest to the last one". With 5
similar-sized faces that choice FLIPS as sizes fluctuate, so the crop swayed
between people. IT HAD NO IDEA WHO WAS SPEAKING.

### Mouth-motion speaker detection
YuNet returns 15 values per face: x,y,w,h + 5 landmarks + score.
Indices 10..13 are the TWO MOUTH CORNERS. So:

    crop the mouth region -> grayscale -> resize to 24x16 -> normalise
    (subtract mean, divide by std, so lighting change is not read as speech)
    energy = mean |patch - recent patches|

A talking mouth changes shape constantly; a listening one barely does. No extra
model, no extra dependency.

### THE KEY INSIGHT: decide ONCE PER CLIP, do not follow the conversation
The first attempt switched speaker live, with hysteresis and a 1.5s minimum
hold. IT STILL SWAYED, because every switch triggers a slow pan, so with a
switch every couple of seconds the crop never settles.

    live switching: travel 410 px, mean motion 11.4 output px/sample
    ONE speaker per clip: travel 175 px, mean motion 1.6  <- 7x calmer

analyse() is now TWO PASSES:
  1. accumulate mouth energy per PERSISTENT TRACK across the whole clip
  2. pick the track with the highest total, and follow ONLY that person

Clips are ~20s. Real editors CUT between speakers; they do not pan back and
forth. Holding one subject is far more watchable.

### Also fixed in this pass
Motion units (see previous section): deadzone and pan speed must be relative to
CROP width, not source width.

### KNOWN WEAKNESS
Track identity fragments: ~14 tracks were created for ~6 people, because a face
moving more than TRACK_DIST_FRAC (6% of width) between samples spawns a new
track. Energy still aggregates enough to pick a dominant speaker, but tightening
this would make the choice more reliable. Options: match on landmark geometry
rather than centre distance, or raise SAMPLE_HZ so faces move less per sample.

### COST
Render went ~21s -> ~29s per clip: a mouth patch is cropped, normalised and
compared for EVERY face on EVERY sample. The low-res proxy optimisation (detect
on 480p, scale crop coords to the master) would more than pay this back.

## WIDE MODE (--fit) 2026-09-08 -- and the honest limits of face tracking

After several rounds of speaker-tracking fixes the framing was STILL wrong.
Diagnostic (per-face mouth energy, printed on real frames):

    at  6s: [0.55, 0.43, 0.60, 0.73, 0.50]
    at 12s: [0.58, 0.57, 0.75, 0.75, 0.74]   <- three-way tie

MOUTH-MOTION ENERGY DOES NOT DISCRIMINATE THE SPEAKER. All faces sit in a narrow
0.43-0.75 band. Cause: each patch is normalised to mean 0 / std 1, which
destroys the very signal wanted - a mouth opening is a big LUMINANCE change.
What remains is head movement and compression noise. No tuning fixes this.

Proper fixes need a real audio-visual model (TalkNet-ASD / Light-ASD) or audio
speaker diarization (pyannote / WhisperX). Both are FREE and run locally; both
add a torch dependency.

### --fit : sidestep the problem instead of solving it
Fits the WHOLE frame into the vertical canvas and fills the rest with a blurred,
darkened copy of the same footage. Nobody is ever cut out, so speaker
identification stops mattering.

    python autoreframe.py --input in.mp4 --output out.mp4 --fit
    python autoreframe.py ... --fit --ratio 4:5 --height 1350   <- BETTER

face_extent() first crops to the bounding box of all faces so the group fills
more of the frame. On this test video it returned 0-1920 (100% of width) -- the
7 people genuinely span the entire frame, so there was nothing to crop. That is
the correct answer, not a bug.

### *** 9:16 IS THE WRONG ASPECT FOR PANEL CONTENT ***
Seven people spanning 1920px CANNOT be made large inside a 1080-wide vertical
frame. 4:5 (1080x1350) shows them markedly bigger with the same
everyone-in-frame guarantee, and both Instagram and TikTok accept it.
Use 9:16 for single-speaker content, 4:5 for panels and group tables.
