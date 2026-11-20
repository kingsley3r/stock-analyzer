"""Breaking-news alerts: a notification on your phone (and a message in the app's
🔔 inbox) when important news about one of your watchlist stocks or coins comes in.

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

from . import inbox
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


VERDICT = {"up": ("📈", "LIKELY UP", "🟢"), "down": ("📉", "LIKELY DOWN", "🔴"),
           "unclear": ("↔️", "UNCLEAR EFFECT", "⚪")}
APP_URL = "https://kingsley3r.github.io/stock-analyzer/"


def format_alert(article: Article, item: dict, quote: dict | None, now: float,
                 explained: dict | None = None, style: str = "B") -> str:
    """One alert as simple HTML (first line = headline). Styles: A compact, B verdict first, C clean."""
    e = html.escape
    mins = max(0, int((now - article.published) // 60))
    ago = f"{mins} min ago" if mins < 60 else f"{mins // 60} h ago"
    source = re.sub(r"^Yahoo \(.*\)$", "Yahoo Finance", article.source)
    name, symbol = e(item["name"]), e(item["symbol"])
    ch = quote.get("change_1d") if quote else None
    dot = "" if ch is None else ("🟢" if ch >= 0 else "🔴")
    pct = "" if ch is None else f"{ch:+.1f}%"
    price = ""
    if quote and quote.get("last") is not None:
        cur = quote.get("currency") or ""
        price = f"{cur}{quote['last']:,.2f}"
    icon, label, _ = VERDICT.get((explained or {}).get("impact"), VERDICT["unclear"])
    summary = e(explained["summary"]) if explained else ""
    why = e(explained["why"]) if explained else ""
    title = e(article.title)

    if style == "A":
        lines = [f"{dot or '🚨'} <b>{symbol} · {name}</b>" + (f" · {price} ({pct})" if price and pct else ""),
                 f"<b>{title}</b>"]
        if explained:
            lines += [summary, f"{icon} <b>{label.title()}:</b> {why}"]
        lines.append(f"<i>{e(source)} · {ago}</i>")
    elif style == "C":
        lines = [f"🚨 <b>{name} ({symbol})</b> {dot} {pct}".rstrip(), f"<i>{title}</i>"]
        if explained:
            lines += [f"<blockquote>{summary}</blockquote>", f"{icon} <b>{label.capitalize()}</b>: {why}"]
        lines.append(f"<i>{e(source)} · {ago}</i>")
    else:  # B: verdict first, so the iPhone lock screen shows it
        head = f"{icon} <b>{label} · {symbol}</b>" if explained else f"🚨 <b>NEWS · {symbol}</b>"
        lines = [head, "━━━━━━━━━━━━━━",
                 f"<b>{name}</b>" + (f" · {price}" if price else "") + (f" {dot} {pct} today" if pct else ""),
                 f"📰 {title}"]
        if explained:
            lines += [f"💬 {summary}", f"💡 <b>Why:</b> {why}"]
        lines.append(f"🕒 {e(source)} · {ago}")
    return "\n".join(lines)


def links(article: Article, quote: dict | None) -> list[dict]:
    """The buttons under the message in the app."""
    row = [{"text": "📰 Read article", "url": article.link}]
    if quote and quote.get("file"):
        row.append({"text": "📊 Open chart", "url": f"#/s/{quote['file']}"})
    return row


def explain(picked, quotes_by_symbol: dict, cfg: dict) -> dict[str, dict]:
    """Asks Claude for a short summary and likely price effect. Alerts still go out without it."""
    if cfg.get("ai_summary", True) is False:
        return {}
    import os
    if not os.environ.get("ANTHROPIC_API_KEY"):
        log.info("News alerts: no ANTHROPIC_API_KEY, sending without AI summary")
        return {}
    from . import ai
    items = [{"id": fingerprint(a), "symbol": it["symbol"], "company": it["name"], "headline": a.title,
              "feed_text": (a.summary or "")[:600], "source": a.source,
              "price_change_today_pct": (quotes_by_symbol.get(it["symbol"]) or {}).get("change_1d")}
             for a, it, _ in picked]
    try:
        return ai.explain_alerts(items, cfg.get("model", "claude-opus-5-5"), cfg.get("effort", "low"))
    except Exception as exc:  # noqa: BLE001
        log.warning("News alerts: AI summary failed, sending without it: %s", exc)
        return {}


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
        state_file: Path, tz: str = "Europe/Istanbul") -> int:
    """Saves new alerts to the inbox, notifies your phone and returns how many there were."""
    cfg = settings.get("news_alerts") or {}
    if cfg.get("enabled", True) is False:
        return 0
    silent = quiet_now(cfg, tz)
    if silent and cfg.get("quiet_mode") == "skip":
        log.info("News alerts: quiet time, not sending")
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
    explained = explain(picked, by_symbol, cfg)
    style = str(cfg.get("style", "B")).upper()
    for a, it, _ in picked:  # one message per headline, each with its own buttons
        quote = by_symbol.get(it["symbol"])
        title, body = inbox.split_head(format_alert(a, it, quote, now, explained.get(fingerprint(a)), style))
        inbox.notify("news", title, body, symbol=it["symbol"], links=links(a, quote), push=not silent)
    for a, _, _ in picked:
        sent[fingerprint(a)] = int(now)
    sent = {k: v for k, v in sent.items() if now - v < 3 * 86400}  # forget after 3 days
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(sent, sort_keys=True))
    log.info("News alerts: %d (%s)%s", len(picked),
             ", ".join(f"{it['symbol']}: {w}" for _, it, w in picked), " in the inbox only (quiet time)" if silent else "")
    return len(picked)
