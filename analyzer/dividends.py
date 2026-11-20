"""Dividends of your watchlist stocks, for the app's dividend planner
(💼 Portfolio > 💰 Dividends).

For each stock we keep the dividends of the last two years (ex-dividend date
and amount per share) plus the next announced dates. The app multiplies them
by the shares you hold (your portfolio never leaves your phone) and projects
the next 12 months: same months as last year, at the latest amount.

Data from Yahoo Finance, fetched once a day and kept in record/dividends.json
(public company data, nothing about you). Free: no AI is used.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)
TZ = ZoneInfo("Europe/Istanbul")


def _as_date(v) -> date | None:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return None


def fetch(symbol: str, today: date) -> dict | None:
    import yfinance as yf
    t = yf.Ticker(symbol)
    since = today - timedelta(days=760)
    history = [[ts.date().isoformat(), round(float(v), 6)]
               for ts, v in (t.dividends if t.dividends is not None else {}).items()
               if ts.date() >= since and float(v) > 0]
    try:
        cal = t.calendar or {}
    except Exception:  # noqa: BLE001 - not every symbol has a calendar
        cal = {}
    cal = cal if isinstance(cal, dict) else {}
    next_ex, next_pay = _as_date(cal.get("Ex-Dividend Date")), _as_date(cal.get("Dividend Date"))
    if not history and not next_ex:
        return None
    return {"history": history,
            "next_ex": next_ex.isoformat() if next_ex and next_ex >= today - timedelta(days=30) else None,
            "next_pay": next_pay.isoformat() if next_pay and next_pay >= today - timedelta(days=30) else None}


def run(watchlist: dict, state_file: Path, today: date | None = None) -> dict:
    """{symbol: {history, next_ex, next_pay}} for every watchlist stock that pays dividends."""
    today = today or datetime.now(TZ).date()
    cache = json.loads(state_file.read_text()) if state_file.exists() else {}
    symbols = [str(s["symbol"]) for s in watchlist.get("stocks") or []]
    if cache.get("fetched") != today.isoformat() or set(cache.get("checked", [])) != set(symbols):
        found = {}
        for sym in symbols:
            try:
                hit = fetch(sym, today)
            except Exception as exc:  # noqa: BLE001
                log.info("Dividends: no data for %s (%s)", sym, exc)
                hit = (cache.get("symbols") or {}).get(sym)
            if hit:
                found[sym] = hit
        cache = {"fetched": today.isoformat(), "checked": sorted(symbols), "symbols": found}
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps(cache, sort_keys=True))
        log.info("Dividends: %d of %d stocks pay dividends", len(found), len(symbols))
    return cache.get("symbols") or {}
