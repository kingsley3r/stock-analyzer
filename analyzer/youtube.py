"""Finds new videos from finance YouTube channels.

Every YouTube channel has a free RSS feed with its latest 15 videos, so no
API key is needed. Transcripts (what is actually said in the video) are
fetched when possible, because titles alone are often clickbait."""
from __future__ import annotations

import calendar
import logging
import re
import time
from dataclasses import dataclass, asdict

import feedparser
import requests

from .news import HEADERS

log = logging.getLogger(__name__)

CHANNEL_FEED = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
TRANSCRIPT_CHARS = 6000  # enough for the main points, keeps AI costs down


@dataclass
class Video:
    channel: str
    topic: str
    title: str
    link: str
    description: str
    published: str
    transcript: str | None = None
    channel_title: str = ""      # the channel's display name, e.g. "CNBC Television"
    video_id: str | None = None
    published_ts: int = 0        # unix time
    views: int | None = None
    likes: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def resolve_channel_id(handle: str) -> str | None:
    """Looks up the channel id (UC...) for a handle like 'CNBCtelevision'."""
    try:
        resp = requests.get(f"https://www.youtube.com/@{handle}", headers=HEADERS, timeout=20,
                            cookies={"CONSENT": "YES+1"})
        resp.raise_for_status()
        m = re.search(r'"(?:channelId|externalId)":"(UC[\w-]{22})"', resp.text) or \
            re.search(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})"', resp.text)
        return m.group(1) if m else None
    except Exception as e:
        log.warning("Could not resolve YouTube handle @%s: %s", handle, e)
        return None


def video_id_from_link(link: str) -> str | None:
    m = re.search(r"(?:v=|youtu\.be/|shorts/)([\w-]{11})", link)
    return m.group(1) if m else None


def fetch_transcript(video_id: str) -> str | None:
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        fetched = YouTubeTranscriptApi().fetch(video_id, languages=["en", "de"])
        text = " ".join(snippet.text for snippet in fetched)
        return re.sub(r"\s+", " ", text)[:TRANSCRIPT_CHARS]
    except Exception as e:
        log.info("No transcript for %s (%s)", video_id, type(e).__name__)
        return None


def _int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_channel_feed(content: bytes | str, name: str, topic: str, since: float) -> list[Video]:
    """Reads a channel's feed: title, link, description, publish time, views and likes."""
    videos = []
    for e in feedparser.parse(content).entries:
        parsed = e.get("published_parsed")
        if not parsed or calendar.timegm(parsed) < since:
            continue
        link = e.get("link", "")
        if "/shorts/" in link:  # skip YouTube Shorts: usually too short to be useful
            continue
        ts = calendar.timegm(parsed)
        videos.append(Video(
            channel=name, topic=topic, title=e.get("title", ""), link=link,
            description=re.sub(r"\s+", " ", e.get("summary", "")).strip()[:500],
            published=time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(ts)),
            channel_title=e.get("author", name),
            video_id=e.get("yt_videoid") or video_id_from_link(link),
            published_ts=ts,
            views=_int((e.get("media_statistics") or {}).get("views")),
            likes=_int((e.get("media_starrating") or {}).get("count")),
        ))
    return videos


def collect_videos(sources: dict, max_per_channel: int = 2, lookback_hours: float | None = None) -> list[Video]:
    hours = lookback_hours or sources.get("lookback_hours", 24)
    since = time.time() - hours * 3600
    want_transcripts = sources.get("youtube_transcripts", True)
    videos: list[Video] = []
    transcript_failures = 0  # failures in a row; YouTube may block cloud servers

    for ch in sources.get("youtube_channels", []) or []:
        name = ch.get("handle") or ch.get("channel_id")
        channel_id = ch.get("channel_id") or resolve_channel_id(ch["handle"])
        if not channel_id:
            continue
        try:
            resp = requests.get(CHANNEL_FEED.format(channel_id=channel_id), headers=HEADERS, timeout=20)
            resp.raise_for_status()
        except Exception as e:
            log.warning("YouTube feed failed for %s: %s", name, e)
            continue

        found = parse_channel_feed(resp.content, name, ch.get("topic", ""), since)[:max_per_channel]
        log.info("YouTube %-22s %d new videos", name, len(found))
        for v in found:
            # After 3 failures in a row we assume YouTube is blocking us and stop trying.
            if want_transcripts and v.video_id and transcript_failures < 3:
                v.transcript = fetch_transcript(v.video_id)
                transcript_failures = 0 if v.transcript else transcript_failures + 1
            videos.append(v)
    return sorted(videos, key=lambda v: v.published_ts, reverse=True)
