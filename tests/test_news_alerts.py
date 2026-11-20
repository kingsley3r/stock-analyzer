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
    assert "🔴 -2.5% today" in sent_texts[0] and "Nvidia" in sent_texts[0]
    assert news_alerts.fingerprint(a) in json.loads(state.read_text())
    assert news_alerts.run([a], WATCH, quotes, {}, state, "t", "c") == 0
    assert len(sent_texts) == 1


def test_disabled_or_no_secrets(tmp_path):
    a = art("Nvidia beats earnings estimates")
    assert news_alerts.run([a], WATCH, [], {"news_alerts": {"enabled": False}}, tmp_path / "s.json", "t", "c") == 0
    assert news_alerts.run([a], WATCH, [], {}, tmp_path / "s.json", None, None) == 0


def test_quiet_time():
    from datetime import datetime
    cfg = {"quiet_enabled": True, "quiet_from": "22:30", "quiet_to": "06:15"}
    at = lambda h, m: datetime(2026, 11, 20, h, m)
    assert news_alerts.quiet_now(cfg, "Europe/Istanbul", at(23, 0))
    assert news_alerts.quiet_now(cfg, "Europe/Istanbul", at(6, 0))
    assert not news_alerts.quiet_now(cfg, "Europe/Istanbul", at(6, 15))
    assert not news_alerts.quiet_now(cfg, "Europe/Istanbul", at(22, 29))
    day = {"quiet_enabled": True, "quiet_from": "12:00", "quiet_to": "13:00"}
    assert news_alerts.quiet_now(day, "Europe/Istanbul", at(12, 30))
    assert not news_alerts.quiet_now(day, "Europe/Istanbul", at(13, 30))
    assert not news_alerts.quiet_now({**cfg, "quiet_enabled": False}, "Europe/Istanbul", at(23, 0))


def test_skip_mode_sends_nothing_in_quiet_time(tmp_path, monkeypatch):
    monkeypatch.setattr(news_alerts, "quiet_now", lambda cfg, tz: True)
    monkeypatch.setattr(news_alerts.telegram, "_call", lambda *a, **k: (_ for _ in ()).throw(AssertionError("sent")))
    a = art("Nvidia beats earnings estimates")
    assert news_alerts.run([a], WATCH, [], {"news_alerts": {"quiet_mode": "skip"}}, tmp_path / "s.json", "t", "c") == 0


def test_load_settings_defaults():
    cfg = news_alerts.load_settings()
    assert cfg["quiet_from"] == "23:00" and cfg["quiet_to"] == "07:00" and cfg["enabled"] is True


def test_alert_with_ai_summary(tmp_path, monkeypatch):
    from analyzer import ai
    sent = []
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(news_alerts.telegram, "_call", lambda token, method, **p: sent.append(p["text"]))
    a = art("Nvidia beats earnings estimates", symbol="NVDA")
    fp = news_alerts.fingerprint(a)
    monkeypatch.setattr(ai, "explain_alerts", lambda items, model, effort: {
        fp: {"id": fp, "summary": "Nvidia earned more than expected.", "impact": "up", "why": "Strong demand <AI>."}})
    news_alerts.run([a], WATCH, [], {}, tmp_path / "s.json", "t", "c")
    assert sent[0].startswith("📈 <b>LIKELY UP · NVDA</b>")
    assert "💬 Nvidia earned more than expected." in sent[0] and "&lt;AI&gt;" in sent[0]


def test_alert_still_sent_when_ai_fails(tmp_path, monkeypatch):
    from analyzer import ai
    sent = []
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(news_alerts.telegram, "_call", lambda token, method, **p: sent.append(p["text"]))
    monkeypatch.setattr(ai, "explain_alerts", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    news_alerts.run([art("Nvidia beats earnings estimates")], WATCH, [], {}, tmp_path / "s.json", "t", "c")
    assert len(sent) == 1 and "📝" not in sent[0]


def test_styles_and_buttons():
    a = art("Nvidia beats earnings estimates", mins_ago=12, symbol="NVDA")
    q = {"symbol": "NVDA", "change_1d": 2.5, "last": 186.2, "currency": "$", "file": "NVDA"}
    ex = {"summary": "Revenue beat.", "impact": "down", "why": "Priced in."}
    now = a.published + 12 * 60
    b = news_alerts.format_alert(a, {"symbol": "NVDA", "name": "Nvidia"}, q, now, ex, "B")
    assert b.splitlines()[0] == "📉 <b>LIKELY DOWN · NVDA</b>" and "$186.20 🟢 +2.5% today" in b and "12 min ago" in b
    a_ = news_alerts.format_alert(a, {"symbol": "NVDA", "name": "Nvidia"}, q, now, ex, "A")
    assert a_.startswith("🟢 <b>NVDA · Nvidia</b> · $186.20 (+2.5%)")
    c = news_alerts.format_alert(a, {"symbol": "NVDA", "name": "Nvidia"}, q, now, ex, "C")
    assert "<blockquote>Revenue beat.</blockquote>" in c
    kb = news_alerts.buttons(a, q)["inline_keyboard"][0]
    assert kb[0]["url"] == a.link and kb[1]["url"].endswith("#/s/NVDA")
