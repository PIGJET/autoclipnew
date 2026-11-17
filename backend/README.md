# ClipForge backend — Milestones 1 + 2

Turns a **YouTube** or **Twitch VOD** URL into highlight-clip candidates using
only lightweight data — video **metadata**, **chat replay**, and an
**audio-only stream** (loudness analysis + per-candidate transcription).
**No video is ever downloaded**; audio is streamed and processed in place.

## Requirements

- Python 3.11
- Network access (the service fetches metadata, chat replay, and audio live)
- No system-wide installs: ffmpeg is the static binary shipped inside the venv
  by the `imageio-ffmpeg` wheel (`imageio_ffmpeg.get_ffmpeg_exe()`), and
  faster-whisper's `base` model auto-downloads to the HF cache on first use.

## Setup (Windows)

From the project root (`autoclipnew/`):

```bat
py -3.11 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
backend\.venv\Scripts\python.exe -m pip check
```

Git Bash equivalent:

```bash
python -m venv backend/.venv
backend/.venv/Scripts/pip install -r backend/requirements.txt
```

## Run

From the `backend/` directory:

```bat
.venv\Scripts\python -m uvicorn server:app --port 8971 --host 127.0.0.1
```

The frontend (`npx serve src`, served at http://localhost:4173) auto-detects the
backend on load. If the backend is down, the UI stays in mock mode.
Alternatively, from the repository root serve it without Node dependencies:
`backend\.venv\Scripts\python.exe -m http.server 4173 --bind 127.0.0.1 --directory src`.
Select the real title under Processed after the queue completes; the initial
mock clips are not the result of ingestion.

`requirements.txt` includes runtime FFmpeg/ASR packages and uses the tested
versions in `requirements-lock.txt` as constraints. `av==16.1.0` is intentional:
PyAV 19.0.2 rejects faster-whisper's `metadata_errors` argument. No global
FFmpeg installation or extra test package is needed.

### Optional processing cap

Chat replay and audio analysis for a multi-hour VOD can take a while. To cap
how many **seconds** of the VOD are processed (useful for quick verification),
either:

- pass `?limit=<seconds>` on `POST /api/ingest`, or
- set the env var `CLIPFORGE_LIMIT=<seconds>` before starting the server.

Default is the **full VOD**. The cap applies to chat, the audio envelope,
candidate selection from every signal, and padded transcription windows.
Heatmap/comments are still fetched as metadata, but candidates beyond the
horizon are excluded. `duration` remains the full source duration for the UI
timeline; detail responses include `processing_limit`. URL + effective limit
form the deduplication key. Negative query limits return HTTP 422.

## API surface

Base URL: `http://localhost:8971`. CORS is open for `http://localhost:4173`.

### `POST /api/ingest?limit=<seconds>`
Body: `{ "url": "<youtube or twitch vod url>" }`
Validates the URL (youtube.com/watch, youtu.be, twitch.tv/videos), returns
`{ "id": "...", "status": "ingesting" }` immediately, and processes in a
background thread. Invalid URLs return `{ "error": "..." }`.

### `GET /api/videos`
List of job summaries:
```json
[{ "id","url","platform","title","duration","status","progress","signal","signals","error","candidateCount" }]
```
`status` ∈ `ingesting | detecting | audio | transcribing | complete | error`;
`progress` is 0–100 **per stage** (it resets when a new stage starts).

### `GET /api/videos/{id}`
Full detail:
```json
{
  "id","url","platform","title","duration","uploader","status","progress",
  "signal","signals","timings","warnings","error","messageCount",
  "timeline": { "baseline": [140 floats 0..1], "spikes": [{ "idx","val" }] },
  "candidates": [{ "id","start","end","score","state":"none","excerpt",
                   "transcript","trigger","reason","signal","signals","transcribed" }]
}
```
`signals` is the list of all signals that produced candidates (`signal` stays
the primary one for back-compat). Each candidate carries the signal(s) it came
from. `timings` holds per-stage seconds. `timeline.spikes` contains both
candidate markers and raw audio-loudness peaks (the coral bars in the UI).

### `GET /api/health`
`{ "ok": true, "jobs": <n> }`

## Pipeline

`INGESTING → DETECTING → AUDIO → TRANSCRIBING → COMPLETE` (or `ERROR`).

1. **INGESTING** — yt-dlp metadata only (title, duration, uploader, heatmap).
2. **DETECTING** — chat replay + replay heatmap (+ timestamped comments when
   chat is unavailable). See per-signal details below.
3. **AUDIO** — yt-dlp resolves the lowest-bitrate **audio-only** format URL
   (Twitch `Audio_Only` HLS, YouTube m4a/webm); ffmpeg streams it to raw PCM
   and a per-second RMS loudness envelope is computed in Python. Rolling
   z-score peaks (≥2.5σ over 15s bins, merged <45s) become audio candidates,
   `reason` = `"audio spike {ratio}×"` (ratio = peak RMS / median RMS).
4. **Fusion** — candidates from all signals are pooled; windows that overlap or
   sit within 30s are merged (union window, higher score + its reason wins,
   +0.5 score bonus clamped ≤9.9 when two *different* signals agree). Top 12.
5. **TRANSCRIBING** — faster-whisper (`base`, CPU int8). Only candidate windows
   are transcribed: each `start−5s … end+5s` window is extracted as a 16 kHz
   mono WAV directly from the audio stream URL (input-side `-ss` seek —
   verified sample-accurate on Twitch HLS) and transcribed. `trigger` = the
   segment overlapping the detection peak (the UI's teal mark). Candidates with
   no chat excerpt get `excerpt` = first ~60 chars of the transcript. If VAD
   yields nothing (music-only windows) transcription retries without VAD;
   `transcribed: true` with an empty transcript means "no speech in window".

### Detection signals

1. **`chat`** — chat replay (Twitch VODs, YouTube livestream VODs). Messages are
   binned into 15s bins; a rolling z-score finds peaks ≥ 2.5σ, merges peaks
   within 45s, keeps the top ≤10. Each candidate spans `peak−10s … peak+20s`.
   `excerpt` = the most-repeated non-trivial message (or top emote) in the window.
   `reason` = `"chat spike {ratio}×"`.
2. **`replay-heatmap`** — YouTube "most replayed" heatmap (returned in the same
   metadata call for many uploads). Local maxima above 60% of max, merged within
   45s. `reason` = `"replay peak {ratio}×"`.
3. **`comments`** — timestamped-comment density (YouTube, ≤500 top comments,
   only tried when chat gives nothing). `reason` = `"comment cluster {n}"`.
4. **`audio`** — loudness spikes (see AUDIO stage above).

If no signal yields candidates the job errors with
`"no analyzable signals for this video"`.

## Notes on the stack

- `requirements.txt` lists `chat-downloader` as specified, but its current PyPI
  release (0.2.8, 2022) no longer parses today's YouTube/Twitch responses. Chat
  replay is therefore fetched directly from the same public endpoints in
  `chat_source.py` (Twitch GQL `VideoComments` via content-offset paging;
  YouTube InnerTube `get_live_chat_replay`). Only JSON is fetched — still no
  media beyond the audio stream.
- **ffmpeg** is project-local: the `imageio-ffmpeg` wheel ships a static binary
  inside the venv; `audio_analysis.py` resolves it via
  `imageio_ffmpeg.get_ffmpeg_exe()`. Nothing is installed system-wide.
- **Whisper**: `faster-whisper` model `base` on CPU (`int8`). The weights
  (roughly 150 MB, plus supporting files) download from Hugging Face on first
  transcription, not at startup or health check. The download requires network
  access and a writable cache; allow extra time for it. Set `HF_HOME` before
  starting the API to choose a cache directory. Subsequent runs use the cache;
  each server process still loads the model once. Cache is separate from the
  virtual environment.
- Temporary candidate WAVs are written to `backend/.cache/` and deleted after
  transcription.

## Repeatable verification

From the repository root, with the API running on port 8971:

```powershell
Invoke-RestMethod http://127.0.0.1:8971/api/health
.\backend\.venv\Scripts\python.exe -m unittest discover -s backend -p test_smoke.py -v
.\backend\.venv\Scripts\python.exe backend\verify_vod.py 'https://www.youtube.com/watch?v=UF8uR6Z6KLc' --limit 300 --output vod-result.json
```

The offline test starts an isolated loopback HTTP server, stubs platform
metadata/chat/comments/audio resolution, generates a deterministic five-minute
WAV with a 15-second loudness peak at 150s, submits an ingest job and polls it.
Real FFmpeg decoding, RMS detection, scoring/fusion and 16 kHz candidate WAV
extraction must yield exactly one candidate at 147–177s with a positive score.
The ASR stub checks the extracted WAV and supplies labeled test text; no model
or internet is used. A second 120s job must exclude the peak, including an
out-of-window heatmap entry, and must not reuse the 300s job. This test does not
verify real speech recognition or YouTube/Twitch access.

`verify_vod.py` uses the real running API without stubs. It requires a complete
job with at least one finite positive score, valid start/end within the cap,
`transcribed: true`, and a nonempty transcript. It prints stage/progress and
elapsed wall time, times out after 900s by default, and can save the full JSON
response. `--api` and `--timeout` override those defaults. A repeated completed
job is explicitly reported as reused; restart the server for fresh timing.
FFmpeg extraction failures retain sanitized stderr in transcription warnings,
so HTTP/decoder errors can be distinguished without printing signed media URLs.
The offline suite also checks this failure diagnostic using a missing input.

Verified November 16, 2026 on Windows / Python 3.11.18: the URL above, first
300 seconds, fresh final run **44.61s**, four candidates, all four transcribed,
no warnings. Best: **57–87s**, score **9.0**, transcript begins “no big deal,
just three stories.” Signals: replay-heatmap. Actual audio analysis and Whisper
ran against the public source; the browser displayed the same four API
candidates and transcript after selecting the source title. An earlier clean
model-cache run reported 56.3s across stages. One initial environment attempt
failed during metadata DNS resolution; retrying with the managed interpreter
completed successfully. Public media availability can change independently of
the offline test.

A second fresh environment created with `python -m venv` and installed using
`python -m pip install -r backend/requirements.txt` passed `pip check`, health,
both offline tests (3.063s before the diagnostic test was added; final suite
8.997s), and real VOD verification in **80.91s** with **3/4 nonempty transcripts**.
One candidate reported `ONNXRuntimeError: FAIL: bad allocation` while three
verification servers had models loaded. An earlier attempt in that environment
was correctly rejected by the verifier after all candidate FFmpeg extractions
failed (exit 3436169992); fresh stream extraction and a new job then succeeded.
Run one API process for the CPU demo; individual transcription warnings remain
visible even when other candidates succeed. A complete status alone is not a
speech-transcription pass.
