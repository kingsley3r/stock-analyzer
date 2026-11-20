from analyzer import track_record as tr

QUOTES = [{"symbol": "NVDA", "name": "Nvidia", "last": 100.0, "last_date": "2026-11-19"},
          {"symbol": "PLTR", "name": "Palantir", "last": 50.0, "last_date": "2026-11-19"}]
DIGEST = {"sent_at": "2026-11-20T03:00:00+00:00", "signals": [
    {"symbol": "NVDA", "action": "buy", "label": "BUY", "confidence": "Medium", "reasons": "x", "name": "Nvidia"},
    {"symbol": "PLTR", "action": "avoid", "label": "DON'T BUY", "confidence": "Low", "reasons": "y", "name": ""},
    {"symbol": "XYZ", "action": "buy", "label": "BUY", "confidence": "Low", "reasons": "", "name": ""}]}


def candles(start_price, closes):
    days = ["2026-11-18", "2026-11-19"] + [f"2026-11-{d}" for d in range(20, 20 + len(closes))]
    prices_ = [start_price, start_price] + closes
    return [[d, p, p, p, p, 0] for d, p in zip(days, prices_)]


def test_record_and_replace_same_day():
    entries = tr.record_digest([], DIGEST, QUOTES)
    assert [(e["symbol"], e["entry_price"], e["date"]) for e in entries] == [
        ("NVDA", 100.0, "2026-11-20"), ("PLTR", 50.0, "2026-11-20")]  # XYZ skipped: no price
    assert tr.record_digest(entries, DIGEST, QUOTES) == entries  # same digest: no change
    later = {**DIGEST, "sent_at": "2026-11-20T08:00:00+00:00", "signals": DIGEST["signals"][:1]}
    assert [e["symbol"] for e in tr.record_digest(entries, later, QUOTES)] == ["NVDA"]


def test_evaluate():
    entries = tr.record_digest([], DIGEST, QUOTES)
    hist = {"NVDA": candles(100, [101, 102, 103, 104, 110]),   # +10% after 5 days -> right
            "PLTR": candles(50, [51, 52])}                      # not 5 days yet -> pending
    r = tr.evaluate(entries, hist)
    nv = next(i for i in r["items"] if i["symbol"] == "NVDA")
    assert nv["1d"] == 1.0 and nv["1w"] == 10.0 and nv["1m"] is None and nv["result"] == "right"
    pl = next(i for i in r["items"] if i["symbol"] == "PLTR")
    assert pl["result"] == "pending" and pl["1d"] == 2.0
    assert r["buy"] == {"scored": 1, "right": 1, "hit_rate": 100, "avg_change": 10.0, "pending": 0}
    assert r["sell"]["pending"] == 1 and r["sell"]["hit_rate"] is None


def test_sell_right_when_price_falls_and_hold_not_scored():
    e = [{"date": "2026-11-20", "symbol": "A", "action": "sell", "entry_date": "2026-11-19", "entry_price": 10.0},
         {"date": "2026-11-20", "symbol": "A", "action": "hold", "entry_date": "2026-11-19", "entry_price": 10.0}]
    r = tr.evaluate(e, {"A": candles(10, [9, 9, 9, 9, 8])})
    assert sorted(i["result"] for i in r["items"]) == ["info", "right"]


def test_storage_roundtrip_encrypted(tmp_path):
    f = tmp_path / "signals.json"
    tr.save_log(f, [{"a": 1}], "pw")
    assert '"a"' not in f.read_text()
    assert tr.load_log(f, "pw") == [{"a": 1}]
    assert tr.load_log(f, "other") == []          # wrong password: start fresh...
    assert list(tmp_path.glob("signals-old-password-*.json"))  # ...but keep the old file
