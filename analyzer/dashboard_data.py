"""Builds the data files the dashboard (site/) shows.

    python -m analyzer.dashboard_data      # writes site/data/

It writes:
  site/data/latest.json            quotes, today's digest + signals, news, videos
  site/data/history/<SYMBOL>.json  two years of daily candles per symbol (for charts)

No AI is used here, so it is free to run often (GitHub runs it every 30 minutes)."""
from __future__ import annotations

import html
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from . import news, news_alerts, prices, telegram, track_record, youtube
from .lock import Locker
from .config import ROOT, load_dotenv, load_yaml

log = logging.getLogger("dashboard")
SITE_DATA = ROOT / "site" / "data"

# --------------------------------------------------------------------------- helpers

def safe_name(symbol: str) -> str:
    """File name for a symbol: '^GSPC' -> '_GSPC', 'BTC-USD' -> 'BTC_USD'."""
    return re.sub(r"[^A-Za-z0-9]", "_", symbol)


def currency_for(symbol: str, group: str) -> str:
    if group == "index":
        return ""
    if symbol.endswith((".DE", ".AS", ".PA", ".MI", ".MC", ".BR")):
        return "€"
    if symbol.endswith(".CO"):
        return "DKK "
    if symbol.endswith(".L"):
        return "GBp "
    return "$"


def entities_to_html(text: str, entities: list[dict]) -> str:
    """Turns a Telegram message (plain text + formatting 'entities') back into HTML.

    Telegram counts positions in UTF-16 units (emojis count as 2), so we work
    on the UTF-16 encoded text to cut it at the right places."""
    data = text.encode("utf-16-le")

    def piece(start: int, end: int) -> str:
        return data[start * 2:end * 2].decode("utf-16-le")

    opens: dict[int, list[str]] = {}
    closes: dict[int, list[str]] = {}
    for e in sorted(entities or [], key=lambda e: (e["offset"], -e["length"])):
        tag = {"bold": "b", "italic": "i", "underline": "u", "code": "code"}.get(e["type"])
        start, end = e["offset"], e["offset"] + e["length"]
        if e["type"] == "text_link":
            opens.setdefault(start, []).append(f'<a href="{html.escape(e["url"])}" target="_blank" rel="noopener">')
            closes.setdefault(end, []).insert(0, "</a>")
        elif e["type"] == "url":
            url = piece(start, end)
            opens.setdefault(start, []).append(f'<a href="{html.escape(url)}" target="_blank" rel="noopener">')
            closes.setdefault(end, []).insert(0, "</a>")
        elif tag:
            opens.setdefault(start, []).append(f"<{tag}>")
            closes.setdefault(end, []).insert(0, f"</{tag}>")

    out, n = [], len(data) // 2
    boundaries = sorted({0, n, *opens, *closes})
    for a, b in zip(boundaries[:-1], boundaries[1:]):
        out += closes.get(a, []) + opens.get(a, [])
        out.append(html.escape(piece(a, b)))
    out += closes.get(n, [])
    return "".join(out).replace("\n", "<br>")


ACTIONS = {"BUY": "buy", "SELL": "sell", "DON'T BUY": "avoid", "DON’T BUY": "avoid",
           "HOLD / WAIT": "hold", "HOLD/WAIT": "hold", "HOLD": "hold", "WATCH": "watch"}
SIGNAL_RE = re.compile(
    r"(BUY|SELL|DON['’]T BUY|HOLD\s*/\s*WAIT|HOLD|WATCH):\s*([\^A-Z0-9][A-Z0-9.\-]*)"
    r"(?:\s*\(([^)]*)\))?(?:.*?Confidence:\s*(⭐+)?\s*(Low|Medium|High))?",
)


def parse_signals(text: str) -> list[dict]:
    """Finds lines like '🟢 BUY: NVDA (Nvidia) · Confidence: ⭐⭐ Medium' plus the
    reasons line under it, and turns them into a list for the dashboard."""
    lines = text.splitlines()
    signals = []
    for i, line in enumerate(lines):
        m = SIGNAL_RE.search(line)
        if not m:
            continue
        action_word = re.sub(r"\s*/\s*", " / ", m.group(1)).replace("’", "'")
        reasons = ""
        if i + 1 < len(lines) and not SIGNAL_RE.search(lines[i + 1]):
            reasons = lines[i + 1].lstrip("➜→-• ").strip()
        signals.append({
            "action": ACTIONS.get(action_word, "watch"),
            "label": action_word,
            "symbol": m.group(2),
            "name": (m.group(3) or "").strip(),
            "confidence": (m.group(5) or "").strip(),
            "reasons": reasons,
        })
    return signals


def latest_digest() -> dict | None:
    """Reads today's digest from the message pinned in your Telegram chat."""
    token, chat_id = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not (token and chat_id):
        log.info("No Telegram settings, so no digest on the dashboard")
        return None
    try:
        chat = telegram._call(token, "getChat", chat_id=chat_id)
    except Exception as e:
        log.warning("Could not read the pinned digest: %s", e)
        return None
    msg = chat.get("pinned_message")
    if not msg or "text" not in msg:
        return None
    return {
        "sent_at": datetime.fromtimestamp(msg["date"], timezone.utc).isoformat(),
        "html": entities_to_html(msg["text"], msg.get("entities", [])),
        "signals": parse_signals(msg["text"]),
    }

def match_symbols(signals: list[dict], quotes: list[dict]) -> None:
    """The AI sometimes writes 'BTC' or 'ASML' instead of 'BTC-USD' or 'ASML.AS'.
    Map each signal to the watchlist symbol so the dashboard can link it."""
    known = {q["symbol"].upper(): q["symbol"] for q in quotes}
    for sig in signals:
        sym = sig["symbol"].upper()
        candidates = [sym, f"{sym}-USD"] + [k for k in known if k.split(".")[0].split("-")[0] == sym]
        name = sig.get("name", "").lower()
        candidates += [q["symbol"].upper() for q in quotes if name and q["name"].lower() == name]
        for c in candidates:
            if c in known:
                sig["symbol"] = known[c]
                break


FINNHUB_KEY = os.environ.get("FINNHUB_API_KEY", "").strip()


def live_source(symbol: str, group: str) -> str | None:
    """Where the browser can get live prices for this symbol, if anywhere."""
    if group == "crypto" and symbol.endswith("-USD"):
        return "coinbase"   # free, no key
    if group == "stock" and re.fullmatch(r"[A-Z.]{1,6}", symbol) and "." not in symbol and FINNHUB_KEY:
        return "finnhub"    # US stocks, free key
    return None


# --------------------------------------------------------------------------- main

def build() -> None:
    # With DASHBOARD_PASSWORD set (always on GitHub), every file is encrypted.
    # Without it (local preview on your computer), plain files are written.
    password = os.environ.get("DASHBOARD_PASSWORD", "").strip()
    locker = Locker(password) if password else None

    def write(path: Path, obj) -> None:
        body = locker.seal(obj) if locker else obj
        path.write_text(json.dumps(body, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    for old in SITE_DATA.rglob("*.json"):  # start clean, never mix plain and locked files
        old.unlink()

    watchlist = load_yaml("watchlist.yaml")
    sources = load_yaml("sources.yaml")
    hist_dir = SITE_DATA / "history"
    hist_dir.mkdir(parents=True, exist_ok=True)

    quotes = []
    candles_by_symbol = {}
    for entry, df in prices.download_history(watchlist, "2y"):
        symbol, name, group, tags = entry
        snap = prices.snapshot_from_history(entry, df)
        if not snap:
            continue
        candles = [
            [ts.strftime("%Y-%m-%d"), round(float(r.Open), 4), round(float(r.High), 4),
             round(float(r.Low), 4), round(float(r.Close), 4), int(r.Volume or 0)]
            for ts, r in df.iterrows()
        ]
        candles_by_symbol[symbol] = candles
        write(hist_dir / f"{safe_name(symbol)}.json", {"symbol": symbol, "candles": candles})
        q = snap.to_dict()
        q["file"] = safe_name(symbol)
        q["currency"] = currency_for(symbol, group)
        q["spark"] = [c[4] for c in candles[-30:]]
        q["prev_close"] = candles[-2][4] if len(candles) > 1 else None
        q["live"] = live_source(symbol, group)
        quotes.append(q)

    articles = news.collect_news(sources, watchlist)[:150]
    yt_sources = {**sources, "youtube_transcripts": False}  # titles are enough here
    videos = youtube.collect_videos(yt_sources, max_per_channel=5, lookback_hours=72)

    digest = latest_digest()
    if digest:
        match_symbols(digest["signals"], quotes)

    # Track record: add today's signals to the saved log, then score all of them.
    record_file = Path(os.environ.get("RECORD_FILE", ROOT / "record" / "signals.json"))
    record_file.parent.mkdir(parents=True, exist_ok=True)
    saved = track_record.load_log(record_file, password or None)
    entries = track_record.record_digest(saved, digest, quotes)
    if entries != saved or not record_file.exists():  # only write when something changed
        track_record.save_log(record_file, entries, password or None)
    record = track_record.evaluate(entries, candles_by_symbol)

    latest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "quotes": quotes,
        "digest": digest,
        "track_record": record,
        "watchlist": watchlist,   # the app's watchlist editor starts from this
        # The key is only readable after unlocking with your password.
        "live": {"finnhub_key": FINNHUB_KEY or None},
        "news": [a.to_dict() | {"ts": int(a.published)} for a in articles],
        "videos": [v.to_dict() | {"id": v.video_id} for v in videos],
    }
    write(SITE_DATA / "latest.json", latest)

    # Breaking-news alerts to Telegram. A problem here must never stop the dashboard.
    try:
        news_alerts.run(articles, watchlist, quotes, load_yaml("settings.yaml"),
                        record_file.parent / "alerts.json",
                        os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID"))
    except Exception as exc:  # noqa: BLE001
        log.warning("News alerts failed: %s", exc)
    # lock.json tells the website whether (and how) the data is locked.
    (SITE_DATA / "lock.json").write_text(json.dumps(locker.header() if locker else {"v": 0}), encoding="utf-8")
    log.info("Encrypted with your password: %s", bool(locker))
    log.info("Dashboard data written: %d quotes, %d articles, %d videos, digest=%s, signals=%s",
             len(quotes), len(articles), len(videos), bool(digest),
             [f'{s["label"]} {s["symbol"]}' for s in digest["signals"]] if digest else None)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
    load_dotenv()
    build()
