"""Earnings calendar: when your watchlist companies report results, plus a
Telegram reminder the evening before (default 18:00 Istanbul).

Dates come from Finnhub (US companies, with your free FINNHUB_API_KEY) and
Yahoo Finance (everything else). They are fetched once a day and kept in
record/earnings.json, together with which reminders were already sent.
Free: no AI is used.
"""
from __future__ import annotations

import html
import json
import logging
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

from . import telegram
from .news_alerts import APP_URL

log = logging.getLogger(__name__)
TZ = ZoneInfo("Europe/Istanbul")
WHEN = {"bmo": "before the market opens", "amc": "after the market closes", "dmh": "during the day"}


def _finnhub(symbols: set[str], key: str, start: date, end: date) -> dict[str, dict]:
    r = requests.get("https://finnhub.io/api/v1/calendar/earnings",
                     params={"from": start.isoformat(), "to": end.isoformat(), "token": key}, timeout=30)
    r.raise_for_status()
    out = {}
    for it in r.json().get("earningsCalendar") or []:
        sym = str(it.get("symbol", "")).replace(".", "-")
        if sym in symbols and (sym not in out or it["date"] < out[sym]["date"]):
            out[sym] = {"date": it["date"], "hour": it.get("hour") or "",
                        "eps_estimate": it.get("epsEstimate"), "source": "Finnhub"}
    return out


def _yahoo(symbol: str, start: date, end: date) -> dict | None:
    import yfinance as yf
    cal = yf.Ticker(symbol).calendar or {}
    dates = cal.get("Earnings Date") or [] if isinstance(cal, dict) else []
    upcoming = sorted(d for d in dates if isinstance(d, date) and start <= d <= end)
    if not upcoming:
        return None
    return {"date": upcoming[0].isoformat(), "hour": "", "eps_estimate": cal.get("Earnings Average"),
            "source": "Yahoo"}


def refresh(watchlist: dict, finnhub_key: str | None, cache: dict, today: date) -> dict:
    """Fetches upcoming earnings (next 45 days) once a day."""
    if cache.get("fetched") == today.isoformat():
        return cache
    stocks = {str(s["symbol"]): s.get("name", s["symbol"]) for s in watchlist.get("stocks") or []}
    end = today + timedelta(days=45)
    found: dict[str, dict] = {}
    if finnhub_key:
        try:
            found.update(_finnhub(set(stocks), finnhub_key, today, end))
        except Exception as exc:  # noqa: BLE001
            log.warning("Earnings: Finnhub failed: %s", exc)
    for sym in stocks:
        if sym in found:
            continue
        try:
            hit = _yahoo(sym, today, end)
            if hit:
                found[sym] = hit
        except Exception as exc:  # noqa: BLE001
            log.info("Earnings: no Yahoo date for %s (%s)", sym, exc)
    events = sorted(({"symbol": s, "name": stocks[s], **v} for s, v in found.items()), key=lambda e: e["date"])
    log.info("Earnings: %d upcoming dates", len(events))
    return {**cache, "fetched": today.isoformat(), "events": events}


def format_reminder(events: list[dict], quotes_by_symbol: dict) -> str:
    e = html.escape
    lines = ["📅 <b>EARNINGS TOMORROW</b>", "━━━━━━━━━━━━━━"]
    for ev in events:
        q = quotes_by_symbol.get(ev["symbol"]) or {}
        when = WHEN.get(ev.get("hour"), "time not announced")
        est = f" · EPS estimate {ev['eps_estimate']:.2f}" if isinstance(ev.get("eps_estimate"), (int, float)) else ""
        lines.append(f"• <b>{e(ev['name'])}</b> ({e(ev['symbol'])}), {when}{est}")
        if q.get("file"):
            lines[-1] += f' · <a href="{APP_URL}#/s/{q["file"]}">chart</a>'
    lines.append("💡 Prices often jump or drop sharply after earnings.")
    return "\n".join(lines)


def run(watchlist: dict, quotes: list[dict], cfg: dict, state_file: Path, finnhub_key: str | None,
        token: str | None, chat_id: str | None, now: datetime | None = None) -> list[dict]:
    """Refreshes the calendar, sends tomorrow's reminder once, returns upcoming events."""
    now = now or datetime.now(TZ)
    cache = json.loads(state_file.read_text()) if state_file.exists() else {}
    cache = refresh(watchlist, finnhub_key, cache, now.date())
    events = [ev for ev in cache.get("events", []) if ev["date"] >= now.date().isoformat()]
    tomorrow = (now.date() + timedelta(days=1)).isoformat()
    due = [ev for ev in events if ev["date"] == tomorrow]
    reminded = cache.setdefault("reminded", {})
    if (due and token and chat_id and cfg.get("enabled", True) and now.hour >= int(cfg.get("reminder_hour", 18))
            and tomorrow not in reminded):
        telegram._call(token, "sendMessage", chat_id=chat_id, parse_mode="HTML",
                       text=format_reminder(due, {q["symbol"]: q for q in quotes}),
                       link_preview_options={"is_disabled": True})
        reminded[tomorrow] = now.isoformat(timespec="minutes")
        log.info("Earnings: reminder sent for %s", ", ".join(ev["symbol"] for ev in due))
    cache["reminded"] = {d: v for d, v in reminded.items() if d >= now.date().isoformat()}
    state_file.parent.mkdir(parents=True, exist_ok=True)
    new = json.dumps(cache, sort_keys=True, ensure_ascii=False)
    if not state_file.exists() or state_file.read_text() != new:
        state_file.write_text(new)
    return events
