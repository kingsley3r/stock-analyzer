import json
from datetime import date

from analyzer import fundamentals


def test_clean_keeps_known_fields_and_drops_bad_values():
    out = fundamentals.clean({"marketCap": 3_000_000_000_000, "trailingPE": 45.123456, "forwardPE": float("nan"),
                              "sector": "Technology", "recommendationKey": "none", "somethingElse": 1})
    assert out == {"market_cap": 3_000_000_000_000, "pe": 45.1235, "sector": "Technology"}
    assert fundamentals.clean({}) is None


def test_run_fetches_once_a_day_and_keeps_old_numbers(tmp_path):
    state = tmp_path / "fundamentals.json"
    wl = {"stocks": [{"symbol": "NVDA"}, {"symbol": "SAP.DE"}], "crypto": [{"symbol": "BTC-USD"}],
          "indices": [{"symbol": "^GSPC"}]}
    calls = []

    def fake(sym):
        calls.append(sym)
        return {"pe": 30.0} if sym != "SAP.DE" else None

    day = date(2026, 11, 23)
    got = fundamentals.run(wl, state, day, fetcher=fake)
    assert got == {"NVDA": {"pe": 30.0}, "BTC-USD": {"pe": 30.0}}
    assert calls == ["NVDA", "SAP.DE", "BTC-USD"]  # indices are skipped

    fundamentals.run(wl, state, day, fetcher=fake)
    assert len(calls) == 3  # cached for the rest of the day

    def broken(sym):
        raise RuntimeError("Yahoo is down")

    got = fundamentals.run(wl, state, date(2026, 11, 24), fetcher=broken)
    assert got["NVDA"] == {"pe": 30.0}  # yesterday's numbers stay
    assert json.loads(state.read_text())["fetched"] == "2026-11-24"
