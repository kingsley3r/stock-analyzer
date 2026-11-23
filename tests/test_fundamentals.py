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
    got = fundamentals.run(wl, state, day, fetcher=fake, fx=lambda c: 1.1)
    assert got == {"NVDA": {"pe": 30.0}, "BTC-USD": {"pe": 30.0}}
    assert calls == ["NVDA", "SAP.DE", "BTC-USD"]  # indices are skipped

    fundamentals.run(wl, state, day, fetcher=fake)
    assert len(calls) == 3  # cached for the rest of the day

    def broken(sym):
        raise RuntimeError("Yahoo is down")

    got = fundamentals.run(wl, state, date(2026, 11, 24), fetcher=broken, fx=broken)
    assert got["NVDA"] == {"pe": 30.0}  # yesterday's numbers stay
    assert json.loads(state.read_text())["fetched"] == "2026-11-24"


def test_exchange_rates_are_saved_and_kept(tmp_path):
    state = tmp_path / "fundamentals.json"
    wl = {"stocks": [{"symbol": "SAP.DE"}, {"symbol": "TSM"}, {"symbol": "AZN.L"}]}
    data = {"SAP.DE": {"currency": "EUR", "financial_currency": "EUR"},
            "TSM": {"currency": "USD", "financial_currency": "TWD"},
            "AZN.L": {"currency": "GBp", "financial_currency": "USD"}}
    asked = []

    def fx(c):
        asked.append(c)
        return {"EUR": 1.08, "TWD": 0.031, "GBP": 1.27}[c]

    fundamentals.run(wl, state, date(2026, 11, 23), fetcher=data.get, fx=fx)
    assert sorted(asked) == ["EUR", "GBP", "TWD"]
    assert fundamentals.rates(state) == {"USD": 1.0, "EUR": 1.08, "TWD": 0.031, "GBP": 1.27}

    def down(c):
        raise RuntimeError("no rates today")

    fundamentals.run(wl, state, date(2026, 11, 24), fetcher=data.get, fx=down)
    assert fundamentals.rates(state)["EUR"] == 1.08  # yesterday's rate stays


def test_fund_extras_reads_fee_holdings_and_sectors():
    import pandas as pd

    class FD:
        fund_operations = pd.DataFrame({"VWCE": [0.0022]}, index=["Annual Report Expense Ratio"])
        top_holdings = pd.DataFrame({"Name": ["Apple Inc", "Nvidia Corp"], "Holding Percent": [0.045, 0.041]},
                                    index=pd.Index(["AAPL", "NVDA"], name="Symbol"))
        sector_weightings = {"technology": 0.27, "realestate": 0.0, "healthcare": 0.1}

    class T:
        funds_data = FD()
        info = {}

    out = fundamentals.fund_extras(T())
    assert out["fee"] == 0.0022
    assert out["holdings"] == [["AAPL", "Apple Inc", 0.045], ["NVDA", "Nvidia Corp", 0.041]]
    assert out["sectors"] == {"technology": 0.27, "healthcare": 0.1}


def test_fund_extras_falls_back_to_net_expense_ratio():
    class Broken:
        @property
        def fund_operations(self):
            raise KeyError("no data")
        top_holdings = None
        sector_weightings = None

    class T:
        funds_data = Broken()
        info = {"netExpenseRatio": 0.07}

    assert fundamentals.fund_extras(T()) == {"fee": 0.0007}


def test_etfs_are_fetched_too(tmp_path):
    seen = []
    fundamentals.run({"etfs": [{"symbol": "VWCE.DE"}]}, tmp_path / "f.json", date(2026, 11, 23),
                     fetcher=lambda s: seen.append(s) or {"type": "ETF"}, fx=lambda c: None)
    assert seen == ["VWCE.DE"]
