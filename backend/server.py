"""
ClipForge backend — Milestone 1
================================

FastAPI service that turns a YouTube / Twitch VOD URL into highlight-clip
candidates using ONLY lightweight data:

  * video metadata (yt-dlp, skip_download)
  * chat replay (chat-downloader)

No full video is ever downloaded. State is in-memory (fine for M1).

Run (from the backend/ directory):
    .venv\\Scripts\\python -m uvicorn server:app --port 8971
"""

import os
import re
import uuid
import time
import threading
import statistics
from collections import Counter

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import yt_dlp

from chat_source import iter_chat, NoChatReplay
from audio_analysis import (resolve_audio_url, rms_envelope, extract_wav,
                            NoAudioStream)

# ------------------------------------------------------------------ config ---

NBARS = 140                 # must match the UI heatmap resolution
FINE_BIN = 15               # seconds per fine-grained scoring bin
PEAK_Z = 2.5                # z-score threshold for a candidate peak
MERGE_GAP = 45              # merge peaks closer than this (seconds)
MAX_CANDIDATES = 10         # per-signal cap before fusion
FUSED_CAP = 12              # cap after signal fusion
FUSE_GAP = 30               # fuse candidates whose windows sit within this
CLIP_PRE = 10               # candidate start = peak - 10s
CLIP_POST = 20              # candidate end   = peak + 20s
AUDIO_BIN = 15              # seconds per audio scoring bin (same as chat)
TRANSCRIBE_PAD = 5          # transcribe candidate.start-5s .. end+5s
WHISPER_MODEL = "base"      # faster-whisper model, CPU int8

# Optional global cap on how many seconds of chat replay to process.
# Default: full VOD. Set CLIPFORGE_LIMIT=1200 (or pass ?limit=1200) to cap.
DEFAULT_LIMIT = int(os.environ.get("CLIPFORGE_LIMIT", "0")) or None

TRIVIAL = {
    "", "!", "?", ".", "lol", "lmao", "gg", "yes", "no", "haha", "hi",
    "hello", "wtf", "omg", "yo", "ok", "okay",
}

# ------------------------------------------------------------------ app ------

app = FastAPI(title="ClipForge backend", version="0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# in-memory job store: id -> job dict
JOBS = {}
JOBS_LOCK = threading.Lock()


class IngestBody(BaseModel):
    url: str


# ------------------------------------------------------------ url helpers ---

YT_WATCH = re.compile(r"youtube\.com/watch\?[^\s]*v=[\w-]+", re.I)
YT_SHORT = re.compile(r"youtu\.be/[\w-]+", re.I)
TW_VOD = re.compile(r"twitch\.tv/videos/\d+", re.I)


def classify_url(url):
    """Return 'youtube' | 'twitch' | None."""
    url = (url or "").strip()
    if YT_WATCH.search(url) or YT_SHORT.search(url):
        return "youtube"
    if TW_VOD.search(url):
        return "twitch"
    return None


def canonical_key(url, platform):
    """Stable identity for a video URL, ignoring query noise (t=, si=, ...)."""
    if platform == "youtube":
        m = re.search(r"(?:v=|youtu\.be/)([\w-]{6,})", url, re.I)
        return "youtube:" + (m.group(1) if m else url.strip().lower())
    m = re.search(r"twitch\.tv/videos/(\d+)", url, re.I)
    return "twitch:" + (m.group(1) if m else url.strip().lower())


# --------------------------------------------------------------- pipeline ---

def _new_job(url, platform):
    return {
        "id": uuid.uuid4().hex[:12],
        "url": url,
        "platform": platform,
        "title": None,
        "duration": 0,
        "uploader": None,
        "status": "ingesting",      # ingesting|detecting|audio|transcribing|complete|error
        "progress": 0.0,            # 0..100 (per stage)
        "signal": None,             # primary: chat|replay-heatmap|comments|audio
        "signals": [],              # all signals that produced candidates
        "timings": {},              # per-stage seconds
        "error": None,
        "candidates": [],
        "timeline": {"baseline": [0.0] * NBARS, "spikes": []},
    }


def fetch_metadata(url):
    """yt-dlp metadata only — no format download."""
    opts = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        # Do not resolve any playable formats; we only want info json.
        "extract_flat": False,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return {
        "title": info.get("title") or "untitled",
        "duration": int(info.get("duration") or 0),
        "uploader": info.get("uploader") or info.get("channel") or "unknown",
        "heatmap": info.get("heatmap"),   # list of {start_time,end_time,value} or None
    }


def fetch_comments(url, max_comments=500):
    """Secondary metadata pass that also pulls top comments (YouTube)."""
    opts = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "getcomments": True,
        "extractor_args": {"youtube": {
            "max_comments": [str(max_comments), "all", "all", "all"],
            "comment_sort": ["top"],
        }},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return info.get("comments") or []


def collect_chat(job, platform, url, duration, limit):
    """Stream chat replay, binning message times. Updates job['progress']."""
    fine_n = max(1, int(duration // FINE_BIN) + 1)
    fine = [0] * fine_n
    coarse = [0] * NBARS
    # keep the messages themselves for excerpting later: (t, text, emotes)
    msgs = []

    horizon = min(duration, limit) if limit else duration
    horizon = max(1, horizon)

    count = 0
    last_pct = -1
    for t, text, emotes in iter_chat(platform, url, limit=limit):
        if t is None or t < 0:
            continue
        count += 1
        fi = min(fine_n - 1, int(t // FINE_BIN))
        fine[fi] += 1
        ci = min(NBARS - 1, int((t / duration) * NBARS)) if duration else 0
        coarse[ci] += 1
        msgs.append((t, text, emotes))

        # progress by message timestamp / horizon
        pct = min(99.0, (t / horizon) * 100.0)
        if pct - last_pct >= 1:
            last_pct = pct
            with JOBS_LOCK:
                job["progress"] = round(pct, 1)

    return fine, coarse, msgs, count


def _rolling_stats(vals, i, half):
    lo = max(0, i - half)
    hi = min(len(vals), i + half + 1)
    window = vals[lo:hi]
    if len(window) < 2:
        return 0.0, 1.0
    mean = statistics.fmean(window)
    try:
        sd = statistics.pstdev(window)
    except statistics.StatisticsError:
        sd = 0.0
    return mean, (sd if sd > 1e-9 else 1.0)


def pick_excerpt(msgs, start, end):
    """Most-repeated non-trivial message in the window, else top emote/phrase."""
    texts = []
    emotes = []
    for t, text, ems in msgs:
        if t < start or t > end:
            continue
        emotes.extend(ems or [])
        norm = (text or "").strip()
        if not norm:
            continue
        if norm.lower() in TRIVIAL or len(norm) < 3:
            continue
        texts.append(norm)

    if texts:
        counter = Counter(t.lower() for t in texts)
        top_norm, top_n = counter.most_common(1)[0]
        if top_n >= 2:
            # return an original-cased instance of the winner
            for t in texts:
                if t.lower() == top_norm:
                    return t
        # nothing repeated — return the longest single message
        return max(texts, key=len)

    if emotes:
        return Counter(emotes).most_common(1)[0][0]
    return ""


def score_candidates(fine, msgs, duration):
    """z-score peak detection over the 15s-bin message-rate series."""
    n = len(fine)
    if n == 0 or duration <= 0:
        return []

    median = statistics.median(fine) if fine else 0
    median = median if median > 0 else 1

    half = max(2, (600 // FINE_BIN) // 2)   # ~10 min rolling window
    scored = []
    for i, v in enumerate(fine):
        mean, sd = _rolling_stats(fine, i, half)
        z = (v - mean) / sd
        scored.append((i, v, z))

    # peaks above threshold
    peaks = [(i, v, z) for (i, v, z) in scored if z >= PEAK_Z and v > median]
    peaks.sort(key=lambda x: x[2], reverse=True)

    # greedy merge: drop peaks within MERGE_GAP of an already-kept, stronger peak
    kept = []
    for i, v, z in peaks:
        peak_t = i * FINE_BIN + FINE_BIN / 2.0
        if any(abs(peak_t - (ki * FINE_BIN + FINE_BIN / 2.0)) < MERGE_GAP
               for ki, _, _ in kept):
            continue
        kept.append((i, v, z))
        if len(kept) >= MAX_CANDIDATES:
            break

    # emit in chronological order
    kept.sort(key=lambda x: x[0])
    candidates = []
    for n_c, (i, v, z) in enumerate(kept, 1):
        peak_t = i * FINE_BIN + FINE_BIN / 2.0
        start = max(0, int(peak_t - CLIP_PRE))
        end = min(int(duration), int(peak_t + CLIP_POST))
        if end <= start:
            end = min(int(duration), start + 5)
        ratio = v / median
        score = min(9.9, round(3.5 + z * 0.9, 1))
        excerpt = pick_excerpt(msgs, start, end)
        candidates.append({
            "id": "d%d" % n_c,
            "start": start,
            "end": end,
            "score": score,
            "state": "none",
            "excerpt": excerpt or "",
            "transcript": "",     # filled by the TRANSCRIBING stage
            "trigger": "",
            "reason": "chat spike %.1f×" % ratio,
            "signal": "chat",
            "_peak": peak_t,
        })
    return candidates


def build_timeline(coarse, candidates, duration):
    mx = max(coarse) if coarse and max(coarse) > 0 else 1
    baseline = [round(c / mx, 4) for c in coarse]
    spikes = []
    for cand in candidates:
        mid = (cand["start"] + cand["end"]) / 2.0
        idx = min(NBARS - 1, int((mid / duration) * NBARS)) if duration else 0
        val = round(min(1.0, cand["score"] / 9.9), 4)
        spikes.append({"idx": idx, "val": val})
    return {"baseline": baseline, "spikes": spikes}


# ---- fallback signal 2: YouTube "most replayed" heatmap ---------------------

def score_from_heatmap(heatmap, duration):
    """Peaks from yt-dlp's most-replayed heatmap (value-based, not z-score)."""
    entries = [(float(h["start_time"]), float(h["end_time"]), float(h["value"]))
               for h in heatmap
               if h.get("value") is not None and h.get("start_time") is not None]
    if not entries:
        return [], {"baseline": [0.0] * NBARS, "spikes": []}
    entries.sort(key=lambda e: e[0])

    vals = [v for _, _, v in entries]
    mx = max(vals) or 1.0
    med = statistics.median(vals) or (mx * 0.5) or 1.0
    thresh = 0.6 * mx

    # local maxima above 60% of max
    peaks = []
    for i, (s, e, v) in enumerate(entries):
        left = entries[i - 1][2] if i > 0 else -1
        right = entries[i + 1][2] if i < len(entries) - 1 else -1
        if v >= thresh and v >= left and v >= right:
            peaks.append(((s + e) / 2.0, v))
    peaks.sort(key=lambda p: p[1], reverse=True)

    kept = []
    for center, v in peaks:
        if any(abs(center - kc) < MERGE_GAP for kc, _ in kept):
            continue
        kept.append((center, v))
        if len(kept) >= MAX_CANDIDATES:
            break
    kept.sort(key=lambda p: p[0])

    candidates = []
    for n_c, (center, v) in enumerate(kept, 1):
        start = max(0, int(center - CLIP_PRE))
        end = min(int(duration), int(center + CLIP_POST))
        if end <= start:
            end = min(int(duration), start + 5)
        ratio = v / med if med else 1.0
        score = min(9.9, round(3.0 + v * 6.9, 1))
        candidates.append({
            "id": "d%d" % n_c, "start": start, "end": end, "score": score,
            "state": "none", "excerpt": "", "transcript": "", "trigger": "",
            "reason": "replay peak %.1f×" % ratio,
            "signal": "replay-heatmap", "_peak": center,
        })

    # baseline: resample heatmap to 140 bins (nearest entry by mid-time)
    baseline = [0.0] * NBARS
    for b in range(NBARS):
        t = (b + 0.5) / NBARS * duration
        best = min(entries, key=lambda e: abs((e[0] + e[1]) / 2.0 - t))
        baseline[b] = round(best[2] / mx, 4)
    spikes = []
    for cand in candidates:
        mid = (cand["start"] + cand["end"]) / 2.0
        idx = min(NBARS - 1, int((mid / duration) * NBARS)) if duration else 0
        spikes.append({"idx": idx, "val": round(min(1.0, cand["score"] / 9.9), 4)})
    return candidates, {"baseline": baseline, "spikes": spikes}


# ---- fallback signal 3: timestamped-comment density -------------------------

TS_RE = re.compile(r"\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b")


def _parse_ts(text, duration):
    out = []
    for m in TS_RE.finditer(text or ""):
        h = int(m.group(1) or 0)
        mm = int(m.group(2))
        ss = int(m.group(3))
        sec = h * 3600 + mm * 60 + ss
        if 0 <= sec <= duration:
            out.append(sec)
    return out


def score_from_comments(comments, duration):
    fine_n = max(1, int(duration // FINE_BIN) + 1)
    fine = [0] * fine_n
    coarse = [0] * NBARS
    bin_texts = {}
    total_ts = 0
    for c in comments:
        text = c.get("text") or ""
        for sec in _parse_ts(text, duration):
            total_ts += 1
            fi = min(fine_n - 1, int(sec // FINE_BIN))
            fine[fi] += 1
            ci = min(NBARS - 1, int((sec / duration) * NBARS)) if duration else 0
            coarse[ci] += 1
            bin_texts.setdefault(fi, text.strip()[:80])

    if total_ts == 0:
        return [], {"baseline": [0.0] * NBARS, "spikes": []}, 0

    # peaks: 15s bins with the most timestamp references
    idxs = [i for i, v in enumerate(fine) if v >= 2] or \
           [i for i, v in enumerate(fine) if v >= 1]
    idxs.sort(key=lambda i: fine[i], reverse=True)
    kept = []
    for i in idxs:
        center = i * FINE_BIN + FINE_BIN / 2.0
        if any(abs(center - kc) < MERGE_GAP for kc, _ in kept):
            continue
        kept.append((center, i))
        if len(kept) >= MAX_CANDIDATES:
            break
    kept.sort(key=lambda p: p[0])

    candidates = []
    for n_c, (center, i) in enumerate(kept, 1):
        start = max(0, int(center - CLIP_PRE))
        end = min(int(duration), int(center + CLIP_POST))
        if end <= start:
            end = min(int(duration), start + 5)
        n = fine[i]
        score = min(9.9, round(4.0 + n * 0.8, 1))
        excerpt = bin_texts.get(i, "")
        candidates.append({
            "id": "d%d" % n_c, "start": start, "end": end, "score": score,
            "state": "none", "excerpt": excerpt, "transcript": "",
            "trigger": "", "reason": "comment cluster %d" % n,
            "signal": "comments", "_peak": center,
        })
    timeline = build_timeline(coarse, candidates, duration)
    return candidates, timeline, total_ts


# ---- signal 4: audio loudness spikes (M2) -----------------------------------

def score_audio_candidates(envelope, duration):
    """Rolling z-score peaks over the per-1s RMS envelope, binned to 15s
    (mean RMS per bin) so spikes are sustained loudness, not one-sample pops."""
    if not envelope:
        return [], []
    n_bins = max(1, len(envelope) // AUDIO_BIN)
    bins = []
    for i in range(n_bins):
        seg = envelope[i * AUDIO_BIN:(i + 1) * AUDIO_BIN]
        bins.append(statistics.fmean(seg) if seg else 0.0)

    median = statistics.median(bins) or 1.0
    half = max(2, (600 // AUDIO_BIN) // 2)   # ~10 min rolling window
    peaks = []
    for i, v in enumerate(bins):
        mean, sd = _rolling_stats(bins, i, half)
        z = (v - mean) / sd
        if z >= PEAK_Z and v > median:
            peaks.append((i, v, z))
    peaks.sort(key=lambda x: x[2], reverse=True)

    kept = []
    for i, v, z in peaks:
        center = i * AUDIO_BIN + AUDIO_BIN / 2.0
        if any(abs(center - (ki * AUDIO_BIN + AUDIO_BIN / 2.0)) < MERGE_GAP
               for ki, _, _ in kept):
            continue
        kept.append((i, v, z))
        if len(kept) >= MAX_CANDIDATES:
            break
    kept.sort(key=lambda x: x[0])

    candidates = []
    peak_times = []          # (t_seconds, normalized 0..1) for timeline spikes
    mx = max(bins) or 1.0
    for n_c, (i, v, z) in enumerate(kept, 1):
        center = i * AUDIO_BIN + AUDIO_BIN / 2.0
        start = max(0, int(center - CLIP_PRE))
        end = min(int(duration), int(center + CLIP_POST))
        if end <= start:
            end = min(int(duration), start + 5)
        ratio = v / median
        score = min(9.9, round(3.5 + z * 0.9, 1))
        candidates.append({
            "id": "a%d" % n_c, "start": start, "end": end, "score": score,
            "state": "none", "excerpt": "", "transcript": "", "trigger": "",
            "reason": "audio spike %.1f×" % ratio,
            "signal": "audio", "_peak": center,
        })
        peak_times.append((center, round(min(1.0, v / mx), 4)))
    return candidates, peak_times


def audio_baseline(envelope, duration):
    """Resample the RMS envelope to NBARS as a 0..1 baseline (used when no
    chat/heatmap baseline exists). Envelope may cover < duration (limit)."""
    baseline = [0.0] * NBARS
    if not envelope or duration <= 0:
        return baseline
    mx = max(envelope) or 1.0
    for b in range(NBARS):
        t = (b + 0.5) / NBARS * duration
        i = int(t)
        if i < len(envelope):
            baseline[b] = round(envelope[i] / mx, 4)
    return baseline


# ---- signal fusion (M2) -----------------------------------------------------

def fuse_candidates(cand_lists, duration):
    """Pool candidates from all signals; merge windows that overlap or sit
    within FUSE_GAP seconds. The higher-scoring member wins score/reason/signal;
    +0.5 bonus (clamped 9.9) when two *different* signals agree. Cap FUSED_CAP."""
    pool = []
    for cands in cand_lists:
        pool.extend(cands)
    if not pool:
        return []
    pool.sort(key=lambda c: c["start"])

    groups = []
    for c in pool:
        if groups and c["start"] <= groups[-1]["end"] + FUSE_GAP:
            g = groups[-1]
            g["end"] = max(g["end"], c["end"])
            g["members"].append(c)
        else:
            groups.append({"start": c["start"], "end": c["end"], "members": [c]})

    fused = []
    for g in groups:
        best = max(g["members"], key=lambda c: c["score"])
        signals = sorted({m["signal"] for m in g["members"]})
        score = best["score"]
        if len(signals) >= 2:
            score = min(9.9, round(score + 0.5, 1))
        excerpt = best["excerpt"] or next(
            (m["excerpt"] for m in g["members"] if m["excerpt"]), "")
        fused.append({
            "start": g["start"], "end": min(int(duration), g["end"]),
            "score": score, "state": "none",
            "excerpt": excerpt, "transcript": "", "trigger": "",
            "reason": best["reason"], "signal": best["signal"],
            "signals": signals, "_peak": best["_peak"],
        })

    fused.sort(key=lambda c: c["score"], reverse=True)
    fused = fused[:FUSED_CAP]
    fused.sort(key=lambda c: c["start"])
    for i, c in enumerate(fused, 1):
        c["id"] = "d%d" % i
    return fused


# ---- transcription (M2, faster-whisper base on CPU) -------------------------

_WHISPER = None
_WHISPER_LOCK = threading.Lock()


def get_whisper():
    global _WHISPER
    with _WHISPER_LOCK:
        if _WHISPER is None:
            from faster_whisper import WhisperModel
            _WHISPER = WhisperModel(WHISPER_MODEL, device="cpu",
                                    compute_type="int8")
        return _WHISPER


def transcribe_candidates(job, audio_url, candidates, duration):
    """Extract each candidate window (±5s pad) as 16k mono WAV straight from
    the audio stream URL and transcribe. Never transcribes the whole VOD."""
    if not candidates:
        return
    model = get_whisper()
    cache = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
    os.makedirs(cache, exist_ok=True)

    total = len(candidates)
    for i, c in enumerate(candidates):
        ex_start = max(0, c["start"] - TRANSCRIBE_PAD)
        ex_dur = min(int(duration), c["end"] + TRANSCRIBE_PAD) - ex_start
        wav = os.path.join(cache, "%s_%s.wav" % (job["id"], c["id"]))
        try:
            extract_wav(audio_url, ex_start, ex_dur, wav)

            def run(vad):
                out = []      # (abs_start, abs_end, text)
                segments, _info = model.transcribe(wav, vad_filter=vad)
                for s in segments:
                    text = s.text.strip()
                    if text:
                        out.append((ex_start + s.start, ex_start + s.end, text))
                return out

            parts = run(True)
            if not parts:     # VAD drops music/singing wholesale — retry raw
                parts = run(False)
            c["transcript"] = " ".join(p[2] for p in parts)
            # trigger = the segment overlapping the detection peak
            peak = c.get("_peak", (c["start"] + c["end"]) / 2.0)
            trigger = ""
            for s0, s1, text in parts:
                if s0 <= peak <= s1:
                    trigger = text
                    break
            if not trigger and parts:   # nearest segment as fallback
                trigger = min(parts, key=lambda p: min(
                    abs(p[0] - peak), abs(p[1] - peak)))[2]
            c["trigger"] = trigger
            c["transcribed"] = True    # ran ASR (empty transcript => no speech)
            if not c["excerpt"] and c["transcript"]:
                c["excerpt"] = c["transcript"][:60].strip()
        except Exception as exc:
            job.setdefault("_transcribe_warns", []).append(
                "%s: %s" % (c["id"], exc))
        finally:
            try:
                os.remove(wav)
            except OSError:
                pass
        with JOBS_LOCK:
            job["progress"] = round(((i + 1) / total) * 100.0, 1)


def _strip_internal(candidates):
    out = []
    for c in candidates:
        c = dict(c)
        c.pop("_peak", None)
        out.append(c)
    return out


def process(job, limit):
    """Full pipeline; runs in a background thread.
    Stages: INGESTING -> DETECTING (chat / heatmap / comments) -> AUDIO
    (loudness spikes) -> fusion -> TRANSCRIBING (per-candidate whisper)
    -> COMPLETE. Errors only if *no* signal yields candidates."""
    url = job["url"]
    platform = job["platform"]
    timings = {}
    try:
        # 1. INGESTING ---------------------------------------------------
        t0 = time.time()
        with JOBS_LOCK:
            job["status"] = "ingesting"
            job["progress"] = 0.0
        meta = fetch_metadata(url)
        with JOBS_LOCK:
            job["title"] = meta["title"]
            job["duration"] = meta["duration"]
            job["uploader"] = meta["uploader"]

        duration = meta["duration"]
        if not duration or duration <= 0:
            raise RuntimeError("could not determine video duration")
        timings["ingest"] = round(time.time() - t0, 1)

        # 2. DETECTING (chat / heatmap / comments) -----------------------
        t0 = time.time()
        with JOBS_LOCK:
            job["status"] = "detecting"
            job["progress"] = 0.0

        cand_lists = []          # one list per signal that produced candidates
        signals_used = []
        chat_coarse, count = None, 0

        # --- chat replay ------------------------------------------------
        try:
            fine, coarse, msgs, count = collect_chat(job, platform, url, duration, limit)
            if count > 0:
                chat_cands = score_candidates(fine, msgs, duration)
                chat_coarse = coarse
                if chat_cands:
                    cand_lists.append(chat_cands)
                    signals_used.append("chat")
        except NoChatReplay:
            pass
        except Exception as exc:
            job["_chat_warn"] = str(exc)   # network hiccup — other signals go on

        # --- replay heatmap (YouTube uploads) ---------------------------
        heat_tl = None
        if meta.get("heatmap"):
            heat_cands, heat_tl = score_from_heatmap(meta["heatmap"], duration)
            if heat_cands:
                cand_lists.append(heat_cands)
                signals_used.append("replay-heatmap")

        # --- timestamped comments (only when chat gave nothing) ---------
        if "chat" not in signals_used and platform == "youtube":
            try:
                comments = fetch_comments(url)
                com_cands, com_tl, nts = score_from_comments(comments, duration)
                if com_cands:
                    cand_lists.append(com_cands)
                    signals_used.append("comments")
                    count = count or nts
                    if heat_tl is None:
                        heat_tl = com_tl
            except Exception as exc:
                job["_comments_warn"] = str(exc)
        timings["detect"] = round(time.time() - t0, 1)

        # 3. AUDIO (loudness envelope from the audio-only stream) --------
        t0 = time.time()
        with JOBS_LOCK:
            job["status"] = "audio"
            job["progress"] = 0.0
        envelope, audio_peaks, audio_url = [], [], None
        horizon = min(duration, limit) if limit else duration
        try:
            audio_url = resolve_audio_url(url)

            def audio_progress(seconds_done):
                pct = min(99.0, (seconds_done / max(1, horizon)) * 100.0)
                with JOBS_LOCK:
                    job["progress"] = round(pct, 1)

            envelope = rms_envelope(audio_url, limit=limit,
                                    progress_cb=audio_progress)
            audio_cands, audio_peaks = score_audio_candidates(envelope, duration)
            if audio_cands:
                cand_lists.append(audio_cands)
                signals_used.append("audio")
        except Exception as exc:   # includes NoAudioStream — audio is optional
            job["_audio_warn"] = str(exc)
        timings["audio"] = round(time.time() - t0, 1)

        # --- fusion ------------------------------------------------------
        if not cand_lists:
            raise RuntimeError("no analyzable signals for this video")
        candidates = fuse_candidates(cand_lists, duration)

        # --- timeline: baseline priority chat > heatmap > audio ----------
        if chat_coarse is not None:
            timeline = build_timeline(chat_coarse, candidates, duration)
        elif heat_tl is not None:
            timeline = {"baseline": heat_tl["baseline"],
                        "spikes": build_timeline([0] * NBARS, candidates,
                                                 duration)["spikes"]}
        else:
            timeline = {"baseline": audio_baseline(envelope, duration),
                        "spikes": build_timeline([0] * NBARS, candidates,
                                                 duration)["spikes"]}
        # audio peaks land in the spikes array too (coral bars in the UI)
        for t, val in audio_peaks:
            idx = min(NBARS - 1, int((t / duration) * NBARS))
            timeline["spikes"].append({"idx": idx, "val": val})

        # 4. TRANSCRIBING (per-candidate windows only) -------------------
        t0 = time.time()
        with JOBS_LOCK:
            job["status"] = "transcribing"
            job["progress"] = 0.0
        if audio_url and candidates:
            transcribe_candidates(job, audio_url, candidates, duration)
        timings["transcribe"] = round(time.time() - t0, 1)

        with JOBS_LOCK:
            job["candidates"] = _strip_internal(candidates)
            job["timeline"] = timeline
            job["signals"] = signals_used
            job["signal"] = signals_used[0] if signals_used else None
            job["message_count"] = count
            job["timings"] = timings
            job["status"] = "complete"
            job["progress"] = 100.0

    except Exception as exc:
        with JOBS_LOCK:
            job["status"] = "error"
            job["error"] = str(exc)
            job["progress"] = 100.0


# ------------------------------------------------------------------ routes ---

@app.post("/api/ingest")
def ingest(body: IngestBody, limit: int = 0):
    platform = classify_url(body.url)
    if not platform:
        return {
            "error": "unsupported url — expected a youtube.com/watch, "
                     "youtu.be, or twitch.tv/videos URL",
        }
    key = canonical_key(body.url, platform)
    with JOBS_LOCK:
        existing = next((j for j in JOBS.values() if j.get("key") == key), None)
        if existing is not None and existing["status"] != "error":
            # dedupe: same video already ingested/ingesting — return it
            return {"id": existing["id"], "status": existing["status"]}
        if existing is not None:
            del JOBS[existing["id"]]   # ERROR job: allow re-ingest (replace)

    job = _new_job(body.url.strip(), platform)
    job["key"] = key
    with JOBS_LOCK:
        JOBS[job["id"]] = job

    eff_limit = limit or DEFAULT_LIMIT
    t = threading.Thread(target=process, args=(job, eff_limit), daemon=True)
    t.start()

    return {"id": job["id"], "status": "ingesting"}


def _summary(job):
    return {
        "id": job["id"],
        "url": job["url"],
        "platform": job["platform"],
        "title": job["title"],
        "duration": job["duration"],
        "status": job["status"],
        "progress": job["progress"],
        "signal": job["signal"],
        "signals": job["signals"],
        "error": job["error"],
        "candidateCount": len(job["candidates"]),
    }


@app.get("/api/videos")
def list_videos():
    with JOBS_LOCK:
        return [_summary(j) for j in JOBS.values()]


@app.get("/api/videos/{video_id}")
def get_video(video_id: str):
    with JOBS_LOCK:
        job = JOBS.get(video_id)
        if not job:
            return {"error": "not found"}
        return {
            "id": job["id"],
            "url": job["url"],
            "platform": job["platform"],
            "title": job["title"],
            "duration": job["duration"],
            "uploader": job["uploader"],
            "status": job["status"],
            "progress": job["progress"],
            "signal": job["signal"],
            "signals": job["signals"],
            "timings": job["timings"],
            "warnings": {k: job[k] for k in
                         ("_chat_warn", "_comments_warn", "_audio_warn",
                          "_transcribe_warns") if k in job},
            "error": job["error"],
            "messageCount": job.get("message_count", 0),
            "timeline": job["timeline"],
            "candidates": job["candidates"],
        }


@app.get("/api/health")
def health():
    return {"ok": True, "jobs": len(JOBS)}
