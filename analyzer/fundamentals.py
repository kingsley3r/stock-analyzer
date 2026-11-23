"""Company numbers for the app's ⚖️ Compare page: size, valuation, profit,
growth, risk and what analysts think.

Data from Yahoo Finance (yfinance `Ticker.info`), fetched once a day and kept
in record/fundamentals.json (public company data, nothing about you).
Free: no AI is used. Indices are skipped (they have no company numbers).
"""
from __future__ import annotations

import json
import logging
import math
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)
TZ = ZoneInfo("Europe/Istanbul")

# Yahoo field -> our short name. Fractions stay fractions (0.25 = 25%); the app formats them.
FIELDS = {
    "marketCap": "market_cap",
    "trailingPE": "pe",
    "forwardPE": "forward_pe",
    "priceToSalesTrailing12Months": "ps",
    "profitMargins": "margin",
    "revenueGrowth": "revenue_growth",
    "returnOnEquity": "roe",
    "debtToEquity": "debt_equity",
    "beta": "beta",
    "recommendationKey": "rating",
    "numberOfAnalystOpinions": "analysts",
    "targetMeanPrice": "target",
    "sector": "sector",
    "industry": "industry",
}


def clean(info: dict) -> dict | None:
    """Keeps only the fields we show, drops empty or broken values."""
    out = {}
    for yahoo, ours in FIELDS.items():
        v = info.get(yahoo)
        if v is None or v == "" or v == "none":
            continue
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            if math.isnan(v) or math.isinf(v):
                continue
            v = round(float(v), 4) if isinstance(v, float) else v
        out[ours] = v
    return out or None


def fetch(symbol: str) -> dict | None:
    import yfinance as yf
    return clean(yf.Ticker(symbol).info or {})


def run(watchlist: dict, state_file: Path, today: date | None = None, fetcher=fetch) -> dict:
    """{symbol: {market_cap, pe, ...}} for every watchlist stock and coin."""
    today = today or datetime.now(TZ).date()
    cache = json.loads(state_file.read_text()) if state_file.exists() else {}
    symbols = [str(s["symbol"]) for key in ("stocks", "crypto") for s in watchlist.get(key) or []]
    if cache.get("fetched") != today.isoformat() or set(cache.get("checked", [])) != set(symbols):
        old = cache.get("symbols") or {}
        found = {}
        for sym in symbols:
            try:
                hit = fetcher(sym)
            except Exception as exc:  # noqa: BLE001 - one bad symbol must not stop the rest
                log.info("Fundamentals: no data for %s (%s)", sym, exc)
                hit = None
            hit = hit or old.get(sym)  # keep yesterday's numbers when Yahoo has a bad day
            if hit:
                found[sym] = hit
        cache = {"fetched": today.isoformat(), "checked": sorted(symbols), "symbols": found}
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps(cache, sort_keys=True))
        log.info("Fundamentals: numbers for %d of %d symbols", len(found), len(symbols))
    return cache.get("symbols") or {}
