"""Simple technical indicators, written by hand so you can see how they work.

Each function takes a list of closing prices (oldest first)."""
from __future__ import annotations


def pct_change(closes: list[float], periods: int) -> float | None:
    """Percent change between the last close and the close `periods` days earlier."""
    if len(closes) <= periods or closes[-1 - periods] == 0:
        return None
    return (closes[-1] / closes[-1 - periods] - 1) * 100


def sma(closes: list[float], window: int) -> float | None:
    """Simple moving average: the average of the last `window` closes."""
    if len(closes) < window:
        return None
    return sum(closes[-window:]) / window


def rsi(closes: list[float], window: int = 14) -> float | None:
    """Relative Strength Index (Wilder's method), from 0 to 100.

    Above 70 is often called "overbought", below 30 "oversold".
    It compares the size of recent up-days with recent down-days."""
    if len(closes) <= window:
        return None
    gains, losses = [], []
    for prev, cur in zip(closes[:-1], closes[1:]):
        change = cur - prev
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))

    avg_gain = sum(gains[:window]) / window
    avg_loss = sum(losses[:window]) / window
    for g, l in zip(gains[window:], losses[window:]):
        avg_gain = (avg_gain * (window - 1) + g) / window
        avg_loss = (avg_loss * (window - 1) + l) / window

    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def volume_ratio(volumes: list[float], window: int = 20) -> float | None:
    """Yesterday's volume compared with the average of the previous `window` days.
    2.0 means twice the usual trading activity, which often signals news."""
    if len(volumes) <= window:
        return None
    avg = sum(volumes[-1 - window:-1]) / window
    if avg == 0:
        return None
    return volumes[-1] / avg
