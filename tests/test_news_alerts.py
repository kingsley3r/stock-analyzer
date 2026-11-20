import json
import time

from analyzer import news_alerts
from analyzer.news import Article

WATCH = {"stocks": [{"symbol": "NVDA", "name": "Nvidia"}, {"symbol": "META", "name": "Meta"},
                    {"symbol": "SAP.DE", "name": "SAP"}],
         "crypto": [{"symbol": "BTC-USD", "name": "Bitcoin"}]}


def art(title, mins_ago=10, symbol=None, link=None):
    return Article("CNBC", title, link or f"https://x/{hash(title)}", "", time.time() - mins_ago * 60, symbol)


def test_picks_important_news_about_watchlist():
    now = time.time()
    arts = [
        art("Nvidia shares plunge after export curbs"),           # name + important
        art("SAP raises full-year guidance"),                     # symbol base + important
        art("Bitcoin hits record high above $120,000"),           # crypto
        art("Nvidia CEO talks about gaming"),                     # important word CEO -> yes
        art("Apple plunges"),                                     # not on watchlist
        art("Nvidia showcases new robot"),                        # no important word
        art("Nvidia shares plunge after export curbs", 90),       # too old
        art("A meta-analysis of earnings season"),                # 'meta' lowercase is not Meta
    ]
    picked = news_alerts.pick_alerts(arts, WATCH, {}, now, max_alerts=10)
    titles = [a.title for a, _, _ in picked]
    assert "Nvidia shares plunge after export curbs" in titles
    assert "SAP raises full-year guidance" in titles
    assert "Bitcoin hits record high above $120,000" in titles
    assert "Apple plunges" not in titles
    assert "Nvidia showcases new robot" not in titles
    assert "A meta-analysis of earnings season" not in titles
    assert titles.count("Nvidia shares plunge after export curbs") == 1


def test_already_sent_is_skipped_and_state_saved(tmp_path, monkeypatch):
    sent_texts = []
    monkeypatch.setattr(news_alerts.telegram, "_call", lambda token, method, **p: sent_texts.append(p["text"]))
    a = art("Nvidia beats earnings estimates", symbol="NVDA")
    state = tmp_path / "alerts.json"
    quotes = [{"symbol": "NVDA", "change_1d": -2.5}]
    assert news_alerts.run([a], WATCH, quotes, {}, state, "t", "c") == 1
    assert "🔴 -2.50% today" in sent_texts[0] and "Nvidia" in sent_texts[0]
    assert news_alerts.fingerprint(a) in json.loads(state.read_text())
    assert news_alerts.run([a], WATCH, quotes, {}, state, "t", "c") == 0
    assert len(sent_texts) == 1


def test_disabled_or_no_secrets(tmp_path):
    a = art("Nvidia beats earnings estimates")
    assert news_alerts.run([a], WATCH, [], {"news_alerts": {"enabled": False}}, tmp_path / "s.json", "t", "c") == 0
    assert news_alerts.run([a], WATCH, [], {}, tmp_path / "s.json", None, None) == 0
