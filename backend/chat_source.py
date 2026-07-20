"""
chat_source — streamable chat-replay fetchers for ClipForge (M1)
================================================================

Yields chat messages as (offset_seconds, text, emote_names) tuples, streamed
so the caller can track progress and stop early via `limit` seconds.

NOTE on the stack: the milestone brief specified `chat-downloader` for this
step. The currently published release (chat-downloader 0.2.8, last updated
2022) no longer parses today's YouTube ("Unable to parse initial video data")
or Twitch ("'data' KeyError", infinite retry) responses. To keep the hard
requirement working — real chat replay, no video download — this module talks
to the same public replay endpoints directly (Twitch GQL VideoComments and
YouTube InnerTube get_live_chat_replay). Only JSON is fetched; no media.
"""

import re
import time

import requests

# --- Twitch public web client (same anonymous client id the site uses) -------
TW_GQL = "https://gql.twitch.tv/gql"
TW_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"
TW_QUERY_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ClipForge/0.1"


class NoChatReplay(Exception):
    """Raised when a source has no usable chat replay."""


# ----------------------------------------------------------------- twitch ---

def _twitch_video_id(url):
    m = re.search(r"twitch\.tv/videos/(\d+)", url, re.I)
    return m.group(1) if m else None


def iter_twitch_chat(url, limit=None, max_pages=20000):
    """Yield (offset_s, text, emotes) for a Twitch VOD, ordered by time."""
    vid = _twitch_video_id(url)
    if not vid:
        raise NoChatReplay("not a twitch VOD url")

    sess = requests.Session()
    sess.headers.update({"Client-ID": TW_CLIENT_ID, "Content-Type": "application/json",
                         "User-Agent": UA})

    def request_page(offset):
        # Offset-based paging: cursor-based paging now fails Twitch's server
        # integrity check for anonymous clients, but contentOffsetSeconds works.
        variables = {"videoID": vid, "contentOffsetSeconds": int(offset)}
        body = [{
            "operationName": "VideoCommentsByOffsetOrCursor",
            "variables": variables,
            "extensions": {"persistedQuery": {"version": 1, "sha256Hash": TW_QUERY_HASH}},
        }]
        for attempt in range(4):
            try:
                r = sess.post(TW_GQL, json=body, timeout=20)
                data = r.json()
                return data[0]["data"]["video"]["comments"]
            except (KeyError, TypeError, ValueError, requests.RequestException):
                if attempt == 3:
                    raise
                time.sleep(0.5 * (attempt + 1))

    offset = 0
    prev_ids = set()      # ids from the previous page (boundary de-dup)
    seen_any = False
    for _ in range(max_pages):
        comments = request_page(offset)
        if not comments:
            break
        edges = comments.get("edges", [])
        if not edges:
            break
        page_ids = set()
        max_off = offset
        for e in edges:
            node = e.get("node", {})
            off = node.get("contentOffsetSeconds")
            if off is None:
                continue
            off = float(off)
            max_off = max(max_off, off)
            nid = node.get("id")
            if nid in prev_ids:
                continue      # duplicate carried over from previous page boundary
            if nid:
                page_ids.add(nid)
            if limit and off > limit:
                return
            frags = node.get("message", {}).get("fragments", []) or []
            text = "".join(f.get("text", "") or "" for f in frags)
            emotes = [f.get("text", "") for f in frags
                      if f.get("emote") and f.get("text")]
            seen_any = True
            yield off, text.strip(), emotes

        if not comments.get("pageInfo", {}).get("hasNextPage"):
            break
        next_off = max_off if max_off > offset else offset + 30
        prev_ids = page_ids
        offset = next_off

    if not seen_any:
        raise NoChatReplay("no chat replay available for this video")


# ---------------------------------------------------------------- youtube ---

def _youtube_video_id(url):
    m = re.search(r"(?:v=|youtu\.be/)([\w-]+)", url, re.I)
    return m.group(1) if m else None


def _yt_runs_text(runs):
    text_parts, emotes = [], []
    for run in runs or []:
        if "text" in run:
            text_parts.append(run["text"])
        elif "emoji" in run:
            emoji = run["emoji"]
            shortcuts = emoji.get("shortcuts") or []
            name = shortcuts[0] if shortcuts else emoji.get("emojiId", "")
            if name:
                emotes.append(name.strip(":"))
                text_parts.append(name)
    return "".join(text_parts).strip(), emotes


def iter_youtube_chat(url, limit=None, max_pages=20000):
    """Yield (offset_s, text, emotes) for a YouTube was_live VOD replay."""
    vid = _youtube_video_id(url)
    if not vid:
        raise NoChatReplay("not a youtube video url")

    sess = requests.Session()
    sess.headers.update({"User-Agent": UA})
    html = sess.get("https://www.youtube.com/watch?v=" + vid,
                    params={"bpctr": "9999999999", "has_verified": "1"},
                    timeout=20).text

    key_m = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
    ver_m = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html)
    if not key_m or not ver_m:
        raise NoChatReplay("no chat replay available for this video")
    api_key, client_version = key_m.group(1), ver_m.group(1)

    cont_m = re.search(
        r'"liveChatRenderer":\{"continuations":\[\{"reloadContinuationData":'
        r'\{"continuation":"([^"]+)"', html)
    if not cont_m:
        # No live-chat replay panel => a plain upload / chat disabled.
        raise NoChatReplay("no chat replay available for this video")
    continuation = cont_m.group(1)

    context = {"client": {"clientName": "WEB", "clientVersion": client_version}}
    endpoint = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay"

    def request_page(cont):
        body = {"context": context, "continuation": cont}
        for attempt in range(4):
            try:
                r = sess.post(endpoint, params={"key": api_key}, json=body, timeout=20)
                return r.json()
            except (ValueError, requests.RequestException):
                if attempt == 3:
                    raise
                time.sleep(0.5 * (attempt + 1))

    seen_any = False
    for _ in range(max_pages):
        data = request_page(continuation)
        lcc = (data or {}).get("continuationContents", {}).get("liveChatContinuation", {})
        actions = lcc.get("actions", [])
        if not actions:
            break
        for a in actions:
            rep = a.get("replayChatItemAction")
            if not rep:
                continue
            off = int(rep.get("videoOffsetTimeMsec", "0")) / 1000.0
            if limit and off > limit:
                return
            for inner in rep.get("actions", []):
                item = inner.get("addChatItemAction", {}).get("item", {})
                renderer = (item.get("liveChatTextMessageRenderer")
                            or item.get("liveChatPaidMessageRenderer"))
                if not renderer:
                    continue
                text, emotes = _yt_runs_text(renderer.get("message", {}).get("runs", []))
                seen_any = True
                yield off, text, emotes

        # advance
        next_cont = None
        for c in lcc.get("continuations", []):
            cd = c.get("liveChatReplayContinuationData")
            if cd and cd.get("continuation"):
                next_cont = cd["continuation"]
                break
        if not next_cont or next_cont == continuation:
            break
        continuation = next_cont

    if not seen_any:
        raise NoChatReplay("no chat replay available for this video")


def iter_chat(platform, url, limit=None):
    if platform == "twitch":
        return iter_twitch_chat(url, limit=limit)
    if platform == "youtube":
        return iter_youtube_chat(url, limit=limit)
    raise NoChatReplay("unsupported platform")
