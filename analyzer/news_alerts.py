"""Breaking-news alerts: sends a Telegram message when important news about one
of your watchlist stocks or coins comes in.

Runs as part of every dashboard update (every 15 minutes on GitHub). It uses no
AI, so it costs nothing: a headline counts as "important" when it names one of
your symbols AND contains a market-moving word (earnings, downgrade, lawsuit,
merger, plunge, ...). Tune the words in IMPORTANT below. On/off and quiet time are set in the
app (⚙️ Settings, saved to config/alerts.yaml) or in config/settings.yaml.

Which headlines were already sent is remembered in record/alerts.json (only
short fingerprints of the links, nothing readable).
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import re
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import telegram
from .news import Article

log = logging.getLogger(__name__)

# Words that usually mean the news can move the price. Matched case-insensitively.
IMPORTANT = [
    r"earnings", r"results", r"revenue", r"profit", r"guidance", r"forecast", r"outlook",
    r"downgrad\w*", r"upgrad\w*", r"price target", r"beats?", r"miss(es|ed)?",
    r"lawsuit", r"sues?", r"sued", r"SEC", r"probe", r"investigat\w*", r"antitrust", r"fined?",
    r"recall\w*", r"FDA", r"approv\w*", r"ban(s|ned)?",
    r"acqui\w*", r"merger", r"buyout", r"takeover", r"to buy", r"stake",
    r"bankrupt\w*", r"default", r"halt\w*", r"delist\w*",
    r"plunge\w*", r"soar\w*", r"surge\w*", r"tumble\w*", r"crash\w*", r"jump\w*", r"sink\w*",
    r"slump\w*", r"skyrocket\w*", r"rall(y|ies|ied)", r"sell-?off", r"record high", r"all-time high",
    r"layoffs?", r"job cuts", r"CEO", r"resign\w*", r"steps? down", r"hack\w*", r"breach",
    r"outage", r"dividend", r"buyback", r"stock split", r"ETF", r"tariff\w*", r"export",
]
IMPORTANT_RE = re.compile(r"\b(" + "|".join(IMPORTANT) + r")\b", re.IGNORECASE)

# Name words that are too common to mean a specific company on their own.
COMMON = {"meta", "intel", "oracle", "block", "visa", "target", "ford"}


def fingerprint(article: Article) -> str:
    return hashlib.sha1((article.link or article.title).encode()).hexdigest()[:12]


def watch_items(watchlist: dict) -> list[dict]:
    items = []
    for group in ("stocks", "crypto"):
        for it in watchlist.get(group) or []:
            symbol = str(it["symbol"])
            items.append({"symbol": symbol, "name": str(it.get("name") or symbol)})
    return items


def match_item(article: Article, items: list[dict]) -> dict | None:
    """Returns the watchlist item the headline is about, or None."""
    if article.symbol:
        return next((i for i in items if i["symbol"] == article.symbol), None)
    title = article.title
    for it in items:
        base = re.split(r"[.\-]", it["symbol"])[0]
        if len(base) >= 3 and re.search(rf"\b{re.escape(base)}\b", title):  # case-sensitive: NVDA, AMD
            return it
        name = it["name"]
        flags = 0 if name.lower() in COMMON else re.IGNORECASE  # "Meta" yes, "meta-analysis" no
        if len(name) >= 3 and re.search(rf"\b{re.escape(name)}\b", title, flags):
            return it
    return None


def pick_alerts(articles: list[Article], watchlist: dict, sent: dict, now: float,
                window_minutes: int = 60, max_alerts: int = 3) -> list[tuple[Article, dict, str]]:
    """Fresh, important, not-yet-sent headlines about your symbols (newest first)."""
    items = watch_items(watchlist)
    picked, seen_titles = [], set()
    for a in sorted(articles, key=lambda x: x.published, reverse=True):
        if now - a.published > window_minutes * 60 or a.published > now + 300:
            continue
        fp = fingerprint(a)
        key = re.sub(r"\W+", " ", a.title.lower()).strip()
        if fp in sent or key in seen_titles:
            continue
        hit = IMPORTANT_RE.search(a.title)
        item = match_item(a, items) if hit else None
        if not item:
            continue
        seen_titles.add(key)
        picked.append((a, item, hit.group(0)))
        if len(picked) >= max_alerts:
            break
    return picked


def format_alert(article: Article, item: dict, quote: dict | None, now: float) -> str:
    mins = max(0, int((now - article.published) // 60))
    ago = f"{mins} min ago" if mins < 60 else f"{mins // 60} h ago"
    move = ""
    if quote and quote.get("change_1d") is not None:
        ch = quote["change_1d"]
        move = f"  {'🟢' if ch >= 0 else '🔴'} {ch:+.2f}% today"
    source = re.sub(r"^Yahoo \(.*\)$", "Yahoo Finance", article.source)
    return (f"🚨 <b>{html.escape(item['name'])}</b> ({html.escape(item['symbol'])}){move}\n"
            f"<a href=\"{html.escape(article.link, quote=True)}\">{html.escape(article.title)}</a>\n"
            f"<i>{html.escape(source)} · {ago}</i>")


def load_settings() -> dict:
    """Alert settings: defaults from config/settings.yaml, overridden by
    config/alerts.yaml, which the app's ⚙️ Settings page writes."""
    from .config import CONFIG_DIR, load_yaml
    cfg = {"enabled": True, "quiet_enabled": True, "quiet_from": "23:00", "quiet_to": "07:00",
           "quiet_mode": "silent", "max_per_update": 3, "window_minutes": 60}
    base = load_yaml("settings.yaml").get("news_alerts") or {}
    if "quiet_hours" in base:  # older format: [23, 7]
        start, end = base.pop("quiet_hours")
        base.setdefault("quiet_from", f"{int(start):02d}:00")
        base.setdefault("quiet_to", f"{int(end):02d}:00")
    cfg.update(base)
    if (CONFIG_DIR / "alerts.yaml").exists():
        cfg.update(load_yaml("alerts.yaml") or {})
    return cfg


def _minutes(hhmm) -> int:
    if isinstance(hhmm, int):  # YAML reads an unquoted 23:00 as 1380 minutes
        return hhmm % 1440
    h, m = str(hhmm).split(":")
    return int(h) * 60 + int(m)


def quiet_now(cfg: dict, tz: str, now: datetime | None = None) -> bool:
    """True inside your quiet time (it may run over midnight, e.g. 23:00 to 07:00)."""
    if not cfg.get("quiet_enabled", True):
        return False
    start, end = _minutes(cfg.get("quiet_from", "23:00")), _minutes(cfg.get("quiet_to", "07:00"))
    now = now or datetime.now(ZoneInfo(tz))
    t = now.hour * 60 + now.minute
    if start == end:
        return False
    return t >= start or t < end if start > end else start <= t < end


def run(articles: list[Article], watchlist: dict, quotes: list[dict], settings: dict,
        state_file: Path, token: str | None, chat_id: str | None, tz: str = "Europe/Istanbul") -> int:
    """Sends new alerts and returns how many were sent."""
    cfg = settings.get("news_alerts") or {}
    if cfg.get("enabled", True) is False:
        return 0
    silent = quiet_now(cfg, tz)
    if silent and cfg.get("quiet_mode") == "skip":
        log.info("News alerts: quiet time, not sending")
        return 0
    if not token or not chat_id:
        log.info("News alerts: no Telegram secrets, skipping")
        return 0
    sent = json.loads(state_file.read_text()) if state_file.exists() else {}
    now = time.time()
    picked = pick_alerts(articles, watchlist, sent, now,
                         window_minutes=int(cfg.get("window_minutes", 60)),
                         max_alerts=int(cfg.get("max_per_update", 3)))
    if not picked:
        log.info("News alerts: nothing new")
        return 0
    by_symbol = {q["symbol"]: q for q in quotes}
    text = "\n\n".join(format_alert(a, it, by_symbol.get(it["symbol"]), now) for a, it, _ in picked)
    telegram._call(token, "sendMessage", chat_id=chat_id, text=text, parse_mode="HTML",
                   disable_notification=silent, link_preview_options={"is_disabled": True})
    for a, _, _ in picked:
        sent[fingerprint(a)] = int(now)
    sent = {k: v for k, v in sent.items() if now - v < 3 * 86400}  # forget after 3 days
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(sent, sort_keys=True))
    log.info("News alerts: sent %d (%s)%s", len(picked),
             ", ".join(f"{it['symbol']}: {w}" for _, it, w in picked), " silently (quiet hours)" if silent else "")
    return len(picked)
