"""Submit and poll a real URL; success requires scored, transcribed candidates."""
import argparse
import json
import math
import time
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("--limit", type=int, default=300)
    parser.add_argument("--api", default="http://127.0.0.1:8971")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--output", help="optional JSON evidence file")
    args = parser.parse_args()
    if args.limit <= 0:
        parser.error("--limit must be positive")

    def request(path, body=None):
        req = Request(args.api + path,
                      data=json.dumps(body).encode() if body else None,
                      headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=30) as response:
            return json.load(response)

    started = time.monotonic()
    submission = request(f"/api/ingest?limit={args.limit}", {"url": args.url})
    if "id" not in submission:
        raise SystemExit(str(submission))
    previous = None
    while True:
        job = request("/api/videos/" + submission["id"])
        stage = (job["status"], job["progress"])
        if stage != previous:
            print(f"{time.monotonic() - started:.1f}s {stage}", flush=True)
            previous = stage
        if job["status"] in ("complete", "error"):
            break
        if time.monotonic() - started > args.timeout:
            raise SystemExit(f"Timed out in {stage}; warnings={job.get('warnings')}")
        time.sleep(1)

    valid = [c for c in job["candidates"]
             if 0 <= c["start"] < c["end"] <= min(args.limit, job["duration"])
             and isinstance(c.get("score"), (int, float))
             and math.isfinite(c["score"]) and c["score"] > 0
             and c.get("transcribed") and c.get("transcript", "").strip()]
    evidence = {"elapsed_seconds": round(time.monotonic() - started, 2),
                "submission_status": submission["status"],
                "verified_candidates": len(valid), "job": job}
    if args.output:
        with open(args.output, "w", encoding="utf-8") as output:
            json.dump(evidence, output, indent=2, ensure_ascii=False)
    if job["status"] != "complete" or not valid:
        raise SystemExit(json.dumps(evidence, indent=2))
    best = max(valid, key=lambda c: c["score"])
    print(f"PASS: {len(valid)}/{len(job['candidates'])} transcribed candidates; "
          f"best {best['start']}–{best['end']}s, score {best['score']}; "
          f"elapsed {evidence['elapsed_seconds']}s")
    if submission["status"] == "complete":
        print("Reused a completed in-memory job; restart API to measure a fresh run.")


if __name__ == "__main__":
    main()
