"""Finds new videos from finance YouTube channels.

Every YouTube channel has a free RSS feed with its latest 15 videos, so no
API key is needed. Transcripts (what is actually said in the video) are
fetched when possible, because titles alone are often clickbait."""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, asdict

import requests

from .news import HEADERS, parse_feed

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


def collect_videos(sources: dict, max_per_channel: int = 2) -> list[Video]:
    since = time.time() - sources.get("lookback_hours", 24) * 3600
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

        # The feed's "summary" field holds the video description.
        entries = parse_feed(resp.content, name, since)
        # Skip YouTube Shorts: usually too short to be useful.
        entries = [e for e in entries if "/shorts/" not in e.link][:max_per_channel]
        log.info("YouTube %-22s %d new videos", name, len(entries))

        for e in entries:
            transcript = None
            vid = video_id_from_link(e.link)
            # After 3 failures in a row we assume YouTube is blocking us and stop trying.
            if want_transcripts and vid and transcript_failures < 3:
                transcript = fetch_transcript(vid)
                transcript_failures = 0 if transcript else transcript_failures + 1
            videos.append(Video(
                channel=name, topic=ch.get("topic", ""), title=e.title, link=e.link,
                description=e.summary[:500],
                published=time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(e.published)),
                transcript=transcript,
            ))
    return videos
