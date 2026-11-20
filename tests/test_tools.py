import json
from datetime import datetime
from zoneinfo import ZoneInfo

from analyzer import earnings, paper, price_alerts
from analyzer.lock import Locker, load_sealed_file


def candles(closes, start=1):
    return [[f"2026-11-{start + i:02d}", 0, 0, 0, c, 0] for i, c in enumerate(closes)]


def test_paper_buy_then_take_profit_and_signal_sell():
    cs = {"AAA": candles([100, 105, 120, 118]), "BBB": candles([50, 50, 48, 45])}
    entries = [
        {"symbol": "AAA", "name": "A", "action": "buy", "entry_date": "2026-11-01", "entry_price": 100},
        {"symbol": "BBB", "name": "B", "action": "buy", "entry_date": "2026-11-01", "entry_price": 50},
        {"symbol": "BBB", "name": "B", "action": "sell", "entry_date": "2026-11-03", "entry_price": 48},
    ]
    r = paper.simulate(entries, cs, {"start_cash": 10000, "per_trade": 1000})
    reasons = {t["symbol"]: t["reason"] for t in r["trades"]}
    assert reasons == {"AAA": "take-profit", "BBB": "signal"}
    aaa = next(t for t in r["trades"] if t["symbol"] == "AAA")
    assert aaa["exit_price"] == 120 and aaa["pnl"] == 200
    assert r["cash"] == 10000 + 200 - 40 and r["positions"] == [] and r["win_rate"] == 50


def test_paper_stop_loss_and_open_position():
    cs = {"AAA": candles([100, 91, 90]), "CCC": candles([10, 11, 12])}
    entries = [{"symbol": "AAA", "action": "buy", "entry_date": "2026-11-01", "entry_price": 100},
               {"symbol": "CCC", "action": "buy", "entry_date": "2026-11-01", "entry_price": 10}]
    r = paper.simulate(entries, cs, {"start_cash": 10000, "per_trade": 1000, "stop_loss": 9, "take_profit": 50})
    assert r["trades"][0]["reason"] == "stop-loss" and r["trades"][0]["exit_price"] == 91
    pos = r["positions"][0]
    assert pos["symbol"] == "CCC" and pos["value"] == 1200 and pos["day_change"] == 100


def test_price_alert_targets_and_moves():
    quotes = [{"symbol": "NVDA", "name": "Nvidia", "group": "stock", "last": 201, "change_1d": 6.2,
               "last_date": "2026-11-20", "currency": "$"},
              {"symbol": "BTC-USD", "name": "Bitcoin", "group": "crypto", "last": 90000, "change_1d": -6,
               "last_date": "2026-11-20", "currency": "$"}]
    cfg = {"targets": [{"symbol": "NVDA", "above": 200}, {"symbol": "NVDA", "below": 150}], "move_pct": 5,
           "crypto_move_pct": 8}
    hits = price_alerts.check(quotes, cfg, {}, "2026-11-20")
    kinds = sorted(k for _, _, k, _ in hits)
    assert kinds == ["above", "move"]          # BTC -6% is under the 8% coin limit
    text = price_alerts.format_alert(quotes[0], "above", cfg["targets"][0])
    assert "PRICE ALERT · NVDA" in text and "$200.00" in text
    fired = {k: "2026-11-20" for k, *_ in hits}
    assert price_alerts.check(quotes, cfg, fired, "2026-11-20") == []


def test_price_alerts_run_saves_state(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(price_alerts.inbox, "notify", lambda kind, title, body, **k: sent.append({"text": title + "\n" + body, "kind": kind}))
    q = [{"symbol": "AMD", "name": "AMD", "group": "stock", "last": 100, "change_1d": -7, "last_date": "2026-11-20",
          "file": "AMD"}]
    state = tmp_path / "pa.json"
    assert price_alerts.run(q, {"move_pct": 5}, {"quiet_enabled": False}, state) == 1
    assert "BIG MOVE · AMD -7.0%" in sent[0]["text"] and "AMD" not in state.read_text()
    assert price_alerts.run(q, {"move_pct": 5}, {"quiet_enabled": False}, state) == 0


def test_sealed_file_roundtrip(tmp_path):
    lk = Locker("pw")
    body = {**lk.header(), **lk.seal({"targets": [{"symbol": "NVDA", "above": 200}]})}
    f = tmp_path / "price_alerts.json"
    f.write_text(json.dumps(body))
    assert load_sealed_file(f, "pw")["targets"][0]["symbol"] == "NVDA"
    assert load_sealed_file(f, "wrong") is None


def test_earnings_reminder_once(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(earnings.inbox, "notify", lambda kind, title, body, **k: sent.append(title + "\n" + body))
    state = tmp_path / "e.json"
    state.write_text(json.dumps({"fetched": "2026-11-20", "events": [
        {"symbol": "NVDA", "name": "Nvidia", "date": "2026-11-21", "hour": "amc", "eps_estimate": 1.2}]}))
    now = datetime(2026, 11, 20, 18, 5, tzinfo=ZoneInfo("Europe/Istanbul"))
    ev = earnings.run({"stocks": []}, [], {}, state, None, now=now)
    assert ev[0]["symbol"] == "NVDA" and len(sent) == 1 and "after the market closes" in sent[0]
    earnings.run({"stocks": []}, [], {}, state, None, now=now)
    assert len(sent) == 1
    early = datetime(2026, 11, 20, 17, 0, tzinfo=ZoneInfo("Europe/Istanbul"))
    state.write_text(json.dumps({"fetched": "2026-11-20", "events": [
        {"symbol": "NVDA", "name": "Nvidia", "date": "2026-11-21"}]}))
    earnings.run({"stocks": []}, [], {}, state, None, now=early)
    assert len(sent) == 1


def test_paper_defaults_match_darius():
    assert paper.DEFAULTS["start_cash"] == 1000 and paper.DEFAULTS["per_trade"] == 100
