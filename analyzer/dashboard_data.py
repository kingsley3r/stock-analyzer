"""Builds the data files the dashboard (site/) shows.

    python -m analyzer.dashboard_data      # writes site/data/

It writes:
  site/data/latest.json            quotes, today's digest + signals, news, videos
  site/data/inbox.json             the 🔔 inbox: alerts, digests and recaps of the last 30 days
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

from . import dividends, earnings, fundamentals, inbox, news, news_alerts, paper, price_alerts, prices, track_record, youtube
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


def latest_digest(items: list[dict]) -> dict | None:
    """The newest morning digest from the inbox (record/inbox/)."""
    item = next((i for i in items if i.get("kind") == "digest"), None)
    if not item:
        log.info("No digest in the inbox yet")
        return None
    return {
        "sent_at": datetime.fromisoformat(item["ts"]).astimezone(timezone.utc).isoformat(),
        "html": item["html"].replace("\n", "<br>"),
        "signals": parse_signals(inbox.strip_tags(item["html"])),
    }

def digest_from_record(entries: list[dict]) -> dict | None:
    """Before the first digest reaches the inbox: show the last saved signals."""
    if not entries:
        return None
    last = max(e["sent_at"] for e in entries)
    return {"sent_at": last, "html": "",
            "signals": [{k: e.get(k, "") for k in ("action", "label", "symbol", "name", "confidence", "reasons")}
                        for e in entries if e["sent_at"] == last]}


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
    record_dir = Path(os.environ.get("RECORD_FILE", ROOT / "record" / "signals.json")).parent
    record_dir.mkdir(parents=True, exist_ok=True)
    price_list = watchlist
    sources = load_yaml("sources.yaml")
    hist_dir = SITE_DATA / "history"
    hist_dir.mkdir(parents=True, exist_ok=True)

    quotes = []
    candles_by_symbol = {}
    for entry, df in prices.download_history(price_list, "2y"):
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

    # Track record: add today's signals to the saved log, then score all of them.
    record_file = Path(os.environ.get("RECORD_FILE", ROOT / "record" / "signals.json"))
    record_file.parent.mkdir(parents=True, exist_ok=True)
    saved = track_record.load_log(record_file, password or None)
    digest = latest_digest(inbox.load_items(password or None)) or digest_from_record(saved)
    if digest:
        match_symbols(digest["signals"], quotes)
    entries = track_record.record_digest(saved, digest, quotes)
    if entries != saved or not record_file.exists():  # only write when something changed
        track_record.save_log(record_file, entries, password or None)
    record = track_record.evaluate(entries, candles_by_symbol)

    alert_cfg = news_alerts.load_settings()
    settings = load_yaml("settings.yaml")

    paper_result = paper.simulate(entries, candles_by_symbol, settings.get("paper_trading"))
    price_cfg = price_alerts.load_config(password or None)

    # Alerts and extras. A problem in one of them must never stop the dashboard.
    def safely(what, fn, default=None):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            log.warning("%s failed: %s", what, exc)
            return default

    safely("Welcome notification", lambda: inbox.welcome_new_phones(record_dir / "push_phones.json", password or None))
    safely("Price alerts", lambda: price_alerts.run(quotes, price_cfg, alert_cfg, record_dir / "price_alerts.json"))
    upcoming = safely("Earnings", lambda: earnings.run(watchlist, quotes, settings.get("earnings") or {},
                                                       record_dir / "earnings.json", FINNHUB_KEY), [])
    safely("News alerts", lambda: news_alerts.run(articles, watchlist, quotes, {"news_alerts": alert_cfg},
                                                  record_dir / "alerts.json"))
    divs = safely("Dividends", lambda: dividends.run(watchlist, record_dir / "dividends.json"), {})
    funda = safely("Fundamentals", lambda: fundamentals.run(watchlist, record_dir / "fundamentals.json"), {})
    safely("Inbox cleanup", inbox.prune)

    latest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "app_version": os.environ.get("APP_VERSION") or None,  # lets phones notice a new app version
        "quotes": quotes,
        "digest": digest,
        "track_record": record,
        "watchlist": watchlist,   # the app's watchlist editor starts from this
        # The key is only readable after unlocking with your password.
        "live": {"finnhub_key": FINNHUB_KEY or None},
        "alerts": alert_cfg,      # shown on the app's Settings page
        "price_alerts": {k: v for k, v in price_cfg.items() if k != "targets"}
                        | {"targets": price_alerts.status(price_cfg, record_dir / "price_alerts.json")},
        "paper": paper_result,
        "earnings": upcoming,
        "dividends": divs,
        "dividend_cfg": settings.get("dividends") or {},
        "fundamentals": funda,    # company numbers for the ⚖️ Compare page
        "fx": safely("Exchange rates", lambda: fundamentals.rates(record_dir / "fundamentals.json"), {"USD": 1.0}),
        # Notifications: the public key the app subscribes with, and how many phones have them on.
        "push": {"key": inbox.public_key(password or None), "phones": len(safely("Phones", inbox.subscriptions, []))},
        "news": [a.to_dict() | {"ts": int(a.published)} for a in articles],
        "videos": [v.to_dict() | {"id": v.video_id} for v in videos],
    }
    write(SITE_DATA / "latest.json", latest)

    # The inbox (🔔 in the app): every alert, digest and recap of the last 30 days.
    items = inbox.load_items(password or None)
    write(SITE_DATA / "inbox.json", {"items": items})
    # lock.json tells the website whether (and how) the data is locked.
    (SITE_DATA / "lock.json").write_text(json.dumps(locker.header() if locker else {"v": 0}), encoding="utf-8")
    log.info("Encrypted with your password: %s", bool(locker))
    log.info("Dashboard data written: %d quotes, %d articles, %d videos, %d inbox messages, digest=%s, signals=%s",
             len(quotes), len(articles), len(videos), len(items), bool(digest),
             [f'{s["label"]} {s["symbol"]}' for s in digest["signals"]] if digest else None)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
    load_dotenv()
    build()
