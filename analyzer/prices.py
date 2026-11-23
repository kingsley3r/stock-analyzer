"""Downloads daily prices from Yahoo Finance (free, via the yfinance library)
and computes a small snapshot of numbers for each symbol."""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, asdict

import yfinance as yf

from . import indicators

log = logging.getLogger(__name__)


@dataclass
class Snapshot:
    symbol: str
    name: str
    group: str            # "index", "stock", "etf" or "crypto"
    last: float
    last_date: str
    change_1d: float | None
    change_5d: float | None
    change_1m: float | None
    rsi14: float | None
    vs_sma50: float | None  # % above (+) or below (-) the 50-day average
    vs_sma200: float | None
    volume_ratio: float | None
    tags: list[str]

    def to_dict(self) -> dict:
        d = asdict(self)
        return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in d.items()}


def _clean(values) -> list[float]:
    return [float(v) for v in values if v is not None and not math.isnan(float(v))]


def build_snapshot(symbol, name, group, tags, closes, volumes, last_date) -> Snapshot | None:
    closes = _clean(closes)
    volumes = _clean(volumes)
    if len(closes) < 2:
        return None
    last = closes[-1]
    sma50 = indicators.sma(closes, 50)
    sma200 = indicators.sma(closes, 200)
    return Snapshot(
        symbol=symbol,
        name=name,
        group=group,
        last=last,
        last_date=last_date,
        change_1d=indicators.pct_change(closes, 1),
        change_5d=indicators.pct_change(closes, 5),
        change_1m=indicators.pct_change(closes, 21),
        rsi14=indicators.rsi(closes, 14),
        vs_sma50=(last / sma50 - 1) * 100 if sma50 else None,
        vs_sma200=(last / sma200 - 1) * 100 if sma200 else None,
        volume_ratio=indicators.volume_ratio(volumes) if group != "index" else None,
        tags=list(tags or []),
    )


def _entries(watchlist: dict) -> list[tuple[str, str, str, list]]:
    entries = []
    for group_key, group in (("indices", "index"), ("stocks", "stock"), ("etfs", "etf"), ("crypto", "crypto")):
        for item in watchlist.get(group_key, []) or []:
            entries.append((str(item["symbol"]), item.get("name", item["symbol"]), group, item.get("tags", [])))
    return entries


def download_history(watchlist: dict, period: str = "1y") -> list[tuple[tuple, "pd.DataFrame"]]:
    """Downloads daily prices for every symbol in one request.
    Returns (symbol, name, group, tags) together with a table of
    Open/High/Low/Close/Volume rows, one per trading day."""
    entries = _entries(watchlist)
    symbols = [e[0] for e in entries]
    if not symbols:
        return []
    log.info("Downloading %s of prices for %d symbols", period, len(symbols))
    data = yf.download(
        symbols, period=period, interval="1d", group_by="ticker",
        auto_adjust=True, progress=False,
        threads=False,  # one at a time: avoids "database is locked" errors in yfinance's cache
    )
    out = []
    for entry in entries:
        symbol = entry[0]
        try:
            df = data[symbol] if len(symbols) > 1 else data
            df = df.dropna(subset=["Close"])
            if df.empty:
                raise ValueError("no data")
            out.append((entry, df))
        except Exception as e:  # one bad symbol should not stop everything
            log.warning("No price data for %s: %s", symbol, e)
    return out


def snapshot_from_history(entry: tuple, df) -> Snapshot | None:
    symbol, name, group, tags = entry
    return build_snapshot(
        symbol, name, group, tags,
        df["Close"].tolist(), df["Volume"].tolist(),
        df.index[-1].strftime("%Y-%m-%d"),
    )


def fetch_snapshots(watchlist: dict) -> list[Snapshot]:
    """One snapshot (latest numbers) per symbol, based on one year of data."""
    snaps = (snapshot_from_history(entry, df) for entry, df in download_history(watchlist, "1y"))
    return [s for s in snaps if s]
