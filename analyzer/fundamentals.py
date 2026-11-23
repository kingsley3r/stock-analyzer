"""Company numbers for the app's ⚖️ Compare page: size, valuation, profit,
growth, risk and what analysts think. Plus exchange rates to US dollars, so
companies that report in euros, kroner or Taiwan dollars can be compared.

Data from Yahoo Finance (yfinance `Ticker.info`), fetched once a day and kept
in record/fundamentals.json (public company data, nothing about you).
For ETFs (funds) we keep fund numbers instead: yearly fee, fund size, payout
yield, average returns, top holdings and sectors.
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
VERSION = 3  # raise when FIELDS change, so the cache is refreshed the same day
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
    # size and profit (in financial_currency, the currency of the company's reports)
    "totalRevenue": "revenue",
    "netIncomeToCommon": "net_income",
    "freeCashflow": "free_cash_flow",
    "grossMargins": "gross_margin",
    "operatingMargins": "operating_margin",
    "earningsGrowth": "earnings_growth",
    "fullTimeEmployees": "employees",
    # per share (in currency, the currency of the share price)
    "trailingEps": "eps",
    "forwardEps": "forward_eps",
    "sharesOutstanding": "shares",
    "averageVolume": "avg_volume",
    "currency": "currency",
    "financialCurrency": "financial_currency",
    # coins
    "circulatingSupply": "supply",
    "maxSupply": "max_supply",
    # ETFs (funds). Fractions: 0.012 = 1.2%.
    "quoteType": "type",
    "totalAssets": "fund_size",
    "yield": "fund_yield",
    "threeYearAverageReturn": "return_3y",
    "fiveYearAverageReturn": "return_5y",
    "category": "category",
    "fundFamily": "provider",
}


def fund_extras(ticker) -> dict:
    """Fee, top holdings and sectors of an ETF (yfinance funds_data). Missing parts are skipped."""
    out = {}
    fd = ticker.funds_data
    try:
        ops = fd.fund_operations
        col = ops.columns[0]
        fee = ops.loc["Annual Report Expense Ratio", col]
        if fee == fee and fee is not None:
            out["fee"] = round(float(fee), 6)
    except Exception:  # noqa: BLE001
        pass
    if "fee" not in out:
        net = (ticker.info or {}).get("netExpenseRatio")  # given in percent: 0.07 = 0.07%
        if isinstance(net, (int, float)) and net == net:
            out["fee"] = round(float(net) / 100, 6)
    try:
        th = fd.top_holdings
        out["holdings"] = [[str(sym), str(row.get("Name") or sym), round(float(row.get("Holding Percent") or 0), 4)]
                           for sym, row in th.head(10).iterrows()]
    except Exception:  # noqa: BLE001
        pass
    try:
        sw = {k: round(float(v), 4) for k, v in (fd.sector_weightings or {}).items() if v}
        if sw:
            out["sectors"] = dict(sorted(sw.items(), key=lambda kv: -kv[1])[:5])
    except Exception:  # noqa: BLE001
        pass
    return out


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
    t = yf.Ticker(symbol)
    out = clean(t.info or {}) or {}
    if out.get("type") == "ETF":
        try:
            out.update(fund_extras(t))
        except Exception as exc:  # noqa: BLE001
            log.info("Fundamentals: no fund details for %s (%s)", symbol, exc)
    return out or None


def fx_rate(currency: str) -> float | None:
    """How many US dollars one unit of `currency` is worth today."""
    import yfinance as yf
    df = yf.Ticker(f"{currency}USD=X").history(period="5d")
    closes = [float(v) for v in df["Close"] if v == v] if df is not None and len(df) else []
    return round(closes[-1], 6) if closes else None


def currencies(found: dict) -> set[str]:
    out = set()
    for f in found.values():
        for key in ("currency", "financial_currency"):
            c = str(f.get(key) or "").upper()
            if c and c != "USD":
                out.add(c)  # "GBp" (pence) becomes "GBP": the app divides by 100
    return out


def run(watchlist: dict, state_file: Path, today: date | None = None, fetcher=fetch, fx=fx_rate) -> dict:
    """{symbol: {market_cap, pe, ...}} for every watchlist stock and coin."""
    today = today or datetime.now(TZ).date()
    cache = json.loads(state_file.read_text()) if state_file.exists() else {}
    symbols = [str(s["symbol"]) for key in ("stocks", "etfs", "crypto") for s in watchlist.get(key) or []]
    if (cache.get("fetched") != today.isoformat() or cache.get("v") != VERSION
            or set(cache.get("checked", [])) != set(symbols)):
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
        rates = {"USD": 1.0}
        for cur in sorted(currencies(found)):
            try:
                rate = fx(cur)
            except Exception as exc:  # noqa: BLE001
                log.info("Fundamentals: no exchange rate for %s (%s)", cur, exc)
                rate = None
            rate = rate or (cache.get("fx") or {}).get(cur)
            if rate:
                rates[cur] = rate
        cache = {"fetched": today.isoformat(), "checked": sorted(symbols), "symbols": found, "fx": rates, "v": VERSION}
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps(cache, sort_keys=True))
        log.info("Fundamentals: numbers for %d of %d symbols", len(found), len(symbols))
    return cache.get("symbols") or {}


def rates(state_file: Path) -> dict:
    """{currency: US dollars per unit} saved by the last run()."""
    if not state_file.exists():
        return {"USD": 1.0}
    return json.loads(state_file.read_text()).get("fx") or {"USD": 1.0}
