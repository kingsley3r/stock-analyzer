"""Paper trading: follows the app's signals with fake money, so you can see
whether they would have made or lost money before you risk real money.

Nothing is stored separately: every update replays the saved signals
(the track record) against the daily prices, using these rules
(change them under `paper_trading` in config/settings.yaml):

- start with `start_cash` (default $1,000);
- on a 🟢 BUY signal, buy `per_trade` (default $100) worth at the signal's price,
  unless you already hold it or the cash has run out;
- sell everything on a 🔴 SELL or ⛔ DON'T BUY signal, or automatically when the
  closing price is `stop_loss` % below the buy price (default 8 %) or
  `take_profit` % above it (default 15 %).

Simplification: amounts are in dollars for every market. A €100 position
in SAP is treated as $100; currency moves are ignored.
"""
from __future__ import annotations

DEFAULTS = {"start_cash": 1_000, "per_trade": 100, "stop_loss": 8, "take_profit": 15}


def simulate(entries: list[dict], candles_by_symbol: dict[str, list], cfg: dict | None = None) -> dict:
    cfg = {**DEFAULTS, **(cfg or {})}
    cash = float(cfg["start_cash"])
    per_trade = float(cfg["per_trade"])
    stop = 1 - float(cfg["stop_loss"]) / 100
    take = 1 + float(cfg["take_profit"]) / 100

    open_pos: dict[str, dict] = {}   # symbol -> position
    trades: list[dict] = []          # closed trades
    signals_by_day: dict[str, list[dict]] = {}
    for e in entries:
        signals_by_day.setdefault(e["entry_date"], []).append(e)

    # Every trading day that appears in any candle series, in order.
    days = sorted({c[0] for cs in candles_by_symbol.values() for c in cs})
    first_signal = min(signals_by_day) if signals_by_day else None
    close_on = {sym: {c[0]: c[4] for c in cs} for sym, cs in candles_by_symbol.items()}

    def sell(sym: str, day: str, price: float, reason: str) -> None:
        nonlocal cash
        p = open_pos.pop(sym)
        value = p["amount"] * price / p["entry_price"]
        cash += value
        trades.append({**p, "exit_date": day, "exit_price": round(price, 4), "reason": reason,
                       "pnl": round(value - p["amount"], 2),
                       "pnl_pct": round((price / p["entry_price"] - 1) * 100, 2)})

    for day in days:
        if first_signal is None or day < first_signal:
            continue
        # 1) Automatic exits at today's close.
        for sym in list(open_pos):
            price = close_on.get(sym, {}).get(day)
            if price is None or day <= open_pos[sym]["entry_date"]:
                continue
            if price <= open_pos[sym]["entry_price"] * stop:
                sell(sym, day, price, "stop-loss")
            elif price >= open_pos[sym]["entry_price"] * take:
                sell(sym, day, price, "take-profit")
        # 2) Signals based on today's close.
        for s in sorted(signals_by_day.get(day, []), key=lambda x: x["symbol"]):
            sym, price = s["symbol"], s.get("entry_price") or close_on.get(s["symbol"], {}).get(day)
            if not price:
                continue
            if s["action"] == "buy" and sym not in open_pos and cash >= per_trade:
                cash -= per_trade
                open_pos[sym] = {"symbol": sym, "name": s.get("name", sym), "entry_date": day,
                                 "entry_price": round(price, 4), "amount": per_trade}
            elif s["action"] in ("sell", "avoid") and sym in open_pos:
                sell(sym, day, price, "signal")

    # Value open positions at the latest close.
    positions = []
    for p in open_pos.values():
        candles = candles_by_symbol.get(p["symbol"]) or []
        last = candles[-1][4] if candles else p["entry_price"]
        prev = candles[-2][4] if len(candles) > 1 else last
        value = p["amount"] * last / p["entry_price"]
        positions.append({**p, "last": round(last, 4), "value": round(value, 2),
                          "pnl": round(value - p["amount"], 2),
                          "pnl_pct": round((last / p["entry_price"] - 1) * 100, 2),
                          "day_change": round(p["amount"] * (last - prev) / p["entry_price"], 2)})

    invested = sum(p["value"] for p in positions)
    total = cash + invested
    wins = [t for t in trades if t["pnl"] > 0]
    return {
        "rules": cfg,
        "cash": round(cash, 2),
        "invested": round(invested, 2),
        "total": round(total, 2),
        "pnl": round(total - float(cfg["start_cash"]), 2),
        "pnl_pct": round((total / float(cfg["start_cash"]) - 1) * 100, 2),
        "day_change": round(sum(p["day_change"] for p in positions), 2),
        "positions": sorted(positions, key=lambda p: -p["value"]),
        "trades": sorted(trades, key=lambda t: t["exit_date"], reverse=True)[:50],
        "closed": len(trades),
        "win_rate": round(len(wins) / len(trades) * 100) if trades else None,
        "started": first_signal,
    }
