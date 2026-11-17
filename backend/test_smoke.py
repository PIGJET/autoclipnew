"""Offline HTTP/background-job smoke test; no platform or model downloads."""
import json
import math
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
import wave

import uvicorn
import server
from audio_analysis import extract_wav


class SmokeTest(unittest.TestCase):
    def test_ffmpeg_extraction_error_is_actionable(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "missing.wav")
            with self.assertRaisesRegex(RuntimeError, "FFmpeg WAV extraction failed") as caught:
                extract_wav(missing, 0, 1, str(Path(tmp) / "out.wav"))
            self.assertIn("<audio source>", str(caught.exception))
            self.assertNotIn(missing, str(caught.exception))

    def test_audio_background_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp) / "peak.wav"
            # Five minutes, one sustained 15-second peak centered at 157.5s.
            with wave.open(str(fixture), "wb") as wav:
                wav.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                quiet = struct.pack("<8000h", *[
                    int(200 * math.sin(2 * math.pi * 440 * i / 8000))
                    for i in range(8000)])
                loud = struct.pack("<8000h", *[
                    int(20000 * math.sin(2 * math.pi * 440 * i / 8000))
                    for i in range(8000)])
                for second in range(300):
                    wav.writeframesraw(loud if 150 <= second < 165 else quiet)

            extracted = []

            class FakeWhisper:
                def transcribe(self, path, **kwargs):
                    # The pipeline must really extract a valid candidate WAV.
                    with wave.open(path, "rb") as wav:
                        assert wav.getframerate() == 16000
                        assert wav.getnchannels() == 1
                        assert wav.getnframes() > 0
                    extracted.append(path)
                    return iter([SimpleNamespace(start=0, end=1,
                                                 text="offline ASR stub")]), None

            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            http = uvicorn.Server(uvicorn.Config(server.app, host="127.0.0.1",
                                                 port=port, log_level="error"))
            with patch.object(server, "fetch_metadata", return_value={
                "title": "deterministic fixture", "duration": 300,
                # A metadata peak outside the cap must not enter the job.
                "uploader": "test", "heatmap": [
                    {"start_time": 310, "end_time": 330, "value": 1.0}],
            }), patch.object(server, "iter_chat", return_value=iter([])), \
                 patch.object(server, "fetch_comments", return_value=[]), \
                 patch.object(server, "resolve_audio_url", return_value=str(fixture)), \
                 patch.object(server, "get_whisper", return_value=FakeWhisper()):
                thread = threading.Thread(target=http.run, daemon=True)
                thread.start()
                try:
                    deadline = time.monotonic() + 30
                    while not http.started:
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.02)

                    def request(path, data=None):
                        req = Request(f"http://127.0.0.1:{port}" + path,
                                      data=json.dumps(data).encode() if data else None,
                                      headers={"Content-Type": "application/json"})
                        with urlopen(req, timeout=5) as response:
                            return json.load(response)

                    self.assertTrue(request("/api/health")["ok"])
                    result = request("/api/ingest?limit=300", {
                        "url": "https://www.youtube.com/watch?v=offlinefixture"})
                    while True:
                        job = request("/api/videos/" + result["id"])
                        if job["status"] in ("complete", "error"):
                            break
                        self.assertLess(time.monotonic(), deadline, job)
                        time.sleep(0.05)
                    self.assertEqual(job["status"], "complete", job)
                    self.assertEqual(job["signals"], ["audio"])
                    self.assertEqual(len(job["candidates"]), 1)
                    candidate = job["candidates"][0]
                    self.assertEqual((candidate["start"], candidate["end"]), (147, 177))
                    self.assertGreater(candidate["score"], 0)
                    self.assertTrue(candidate["transcript"].strip())
                    self.assertTrue(extracted)
                    self.assertEqual(job["warnings"], {})
                    # Same URL, different horizon must create a different job;
                    # the peak at 150s is outside this shorter analysis window.
                    shorter = request("/api/ingest?limit=120", {
                        "url": "https://www.youtube.com/watch?v=offlinefixture"})
                    self.assertNotEqual(shorter["id"], result["id"])
                    while True:
                        short_job = request("/api/videos/" + shorter["id"])
                        if short_job["status"] in ("complete", "error"):
                            break
                        self.assertLess(time.monotonic(), deadline, short_job)
                        time.sleep(0.05)
                    self.assertEqual(short_job["status"], "error", short_job)
                    self.assertEqual(short_job["error"], "no analyzable signals for this video")
                    self.assertEqual(short_job["candidates"], [])
                finally:
                    http.should_exit = True
                    thread.join(timeout=5)
                    with server.JOBS_LOCK:
                        server.JOBS.clear()


if __name__ == "__main__":
    unittest.main()
