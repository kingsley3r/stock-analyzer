"""Collects recent headlines from RSS feeds (free, no API key)."""
from __future__ import annotations

import calendar
import html
import logging
import re
import time
from dataclasses import dataclass, asdict

import feedparser
import requests

log = logging.getLogger(__name__)

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; stock-analyzer/1.0)"}
YAHOO_SYMBOL_FEED = "https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US"


@dataclass
class Article:
    source: str
    title: str
    link: str
    summary: str
    published: float  # unix timestamp
    symbol: str | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["published"] = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(self.published))
        return d


def _strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def parse_feed(content: bytes | str, source: str, since: float, symbol: str | None = None) -> list[Article]:
    """Turns raw RSS/Atom content into Article objects newer than `since`."""
    feed = feedparser.parse(content)
    articles = []
    for entry in feed.entries:
        parsed = entry.get("published_parsed") or entry.get("updated_parsed")
        if not parsed:
            continue
        published = calendar.timegm(parsed)
        if published < since:
            continue
        title = _strip_html(entry.get("title", ""))
        if not title:
            continue
        articles.append(Article(
            source=source,
            title=title,
            link=entry.get("link", ""),
            summary=_strip_html(entry.get("summary", ""))[:400],
            published=published,
            symbol=symbol,
        ))
    return articles


def fetch_feed(url: str, source: str, since: float, symbol: str | None = None) -> list[Article]:
    try:
        resp = requests.get(url, headers=HEADERS, timeout=20)
        resp.raise_for_status()
        return parse_feed(resp.content, source, since, symbol)
    except Exception as e:
        log.warning("Feed failed (%s): %s", source, e)
        return []


def dedupe(articles: list[Article]) -> list[Article]:
    """Removes duplicates (same headline from several feeds), newest first."""
    seen, out = set(), []
    for a in sorted(articles, key=lambda a: a.published, reverse=True):
        key = re.sub(r"[^a-z0-9]", "", a.title.lower())[:80]
        if key in seen:
            continue
        seen.add(key)
        out.append(a)
    return out


def collect_news(sources: dict, watchlist: dict) -> list[Article]:
    since = time.time() - sources.get("lookback_hours", 24) * 3600
    articles: list[Article] = []
    for feed in sources.get("news_feeds", []) or []:
        found = fetch_feed(feed["url"], feed["name"], since)
        log.info("%-16s %3d articles", feed["name"], len(found))
        articles += found

    if sources.get("per_symbol_news", True):
        for item in watchlist.get("stocks", []) or []:
            symbol = str(item["symbol"])
            # Keep at most 3 headlines per stock so one company can't flood the digest.
            found = fetch_feed(YAHOO_SYMBOL_FEED.format(symbol=symbol), f"Yahoo ({symbol})", since, symbol)
            articles += found[:3]

    return dedupe(articles)
