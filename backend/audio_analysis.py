"""
audio_analysis — audio-only loudness analysis for ClipForge (M2)
================================================================

Resolves an audio-only stream URL via yt-dlp (no download), feeds it straight
to a project-local static ffmpeg (shipped by the `imageio-ffmpeg` wheel inside
the venv — nothing is installed system-wide), and computes a per-second RMS
loudness envelope from raw PCM. Also extracts short candidate windows as
16 kHz mono WAVs for transcription.

Seek note: `-ss <t>` is placed BEFORE `-i` for fast input seeking. This was
verified sample-accurate on Twitch HLS (mean per-second RMS deviation vs a
full-stream decode: 0.01%), so candidate WAVs line up with envelope times.
"""

import math
import struct
import subprocess

import yt_dlp
from imageio_ffmpeg import get_ffmpeg_exe

FFMPEG = get_ffmpeg_exe()

RMS_SR = 8000          # analysis sample rate (mono s16le)
WAV_SR = 16000         # whisper input sample rate


class NoAudioStream(Exception):
    """Raised when no audio-only format can be resolved."""


def resolve_audio_url(url):
    """Lowest-bitrate audio-only format URL (Twitch 'Audio_Only' HLS or
    YouTube m4a/webm). Metadata call only — nothing is downloaded here."""
    opts = {"skip_download": True, "quiet": True, "no_warnings": True,
            "noplaylist": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    best = None
    for f in info.get("formats") or []:
        if f.get("vcodec") not in (None, "none"):
            continue                       # has video
        if f.get("acodec") in (None, "none"):
            continue                       # no audio (storyboards etc.)
        if not f.get("url"):
            continue
        br = f.get("abr") or f.get("tbr") or 0
        if best is None or br < best[0]:
            best = (br, f["url"])
    if not best:
        raise NoAudioStream("no audio-only stream available")
    return best[1]


def rms_envelope(audio_url, limit=None, progress_cb=None, timeout=3600):
    """Per-1s RMS envelope of the stream. Streams PCM from ffmpeg stdout so
    progress_cb(seconds_done) can fire as data arrives. Honors `limit` (s)."""
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error"]
    if limit:
        cmd += ["-t", str(int(limit))]
    cmd += ["-i", audio_url, "-vn", "-ac", "1", "-ar", str(RMS_SR),
            "-f", "s16le", "pipe:1"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL)
    env = []
    bytes_per_sec = RMS_SR * 2
    buf = b""
    try:
        while True:
            chunk = proc.stdout.read(bytes_per_sec)
            if not chunk:
                break
            buf += chunk
            while len(buf) >= bytes_per_sec:
                sec, buf = buf[:bytes_per_sec], buf[bytes_per_sec:]
                samples = struct.unpack("<%dh" % RMS_SR, sec)
                env.append(math.sqrt(sum(x * x for x in samples) / RMS_SR))
                if progress_cb:
                    progress_cb(len(env))
    finally:
        proc.stdout.close()
        proc.wait(timeout=30)
    return env


def extract_wav(audio_url, start, duration, out_path):
    """Extract [start, start+duration] as 16 kHz mono WAV (input-side seek)."""
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error",
           "-ss", str(max(0, int(start))), "-t", str(int(duration)),
           "-i", audio_url, "-vn", "-ac", "1", "-ar", str(WAV_SR),
           out_path, "-y"]
    subprocess.run(cmd, capture_output=True, timeout=300, check=True)
    return out_path
