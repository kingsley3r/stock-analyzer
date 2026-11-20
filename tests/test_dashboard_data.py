from analyzer.dashboard_data import entities_to_html, match_symbols, parse_signals, safe_name


def test_safe_name():
    assert safe_name("^GSPC") == "_GSPC"
    assert safe_name("BTC-USD") == "BTC_USD"


def test_entities_to_html_with_emoji_offsets():
    text = "🟢 BUY: NVDA\nsee news"
    # "🟢" is 2 UTF-16 units, so "BUY: NVDA" starts at 3
    entities = [{"type": "bold", "offset": 3, "length": 9},
                {"type": "text_link", "offset": 17, "length": 4, "url": "https://x.com/a?b=1&c=2"}]
    out = entities_to_html(text, entities)
    assert out == '🟢 <b>BUY: NVDA</b><br>see <a href="https://x.com/a?b=1&amp;c=2" target="_blank" rel="noopener">news</a>'


def test_entities_escape_plain_text():
    assert entities_to_html("a < b & c", []) == "a &lt; b &amp; c"


def test_parse_signals():
    text = """🎯 Today's signals
🟢 BUY: NVDA (Nvidia) · Confidence: ⭐⭐ Medium
➜ Strong earnings beat 📰 · back above 50-day average 📈

⛔ DON'T BUY: PLTR (Palantir) · Confidence: ⭐ Low
➜ RSI 82, overheated

🟡 HOLD / WAIT: ASML.AS (ASML) · Confidence: ⭐⭐⭐ High
🔴 SELL: BTC-USD · Confidence: ⭐⭐ Medium
➜ Breaking below 200-day average"""
    s = parse_signals(text)
    assert [(x["action"], x["symbol"]) for x in s] == [
        ("buy", "NVDA"), ("avoid", "PLTR"), ("hold", "ASML.AS"), ("sell", "BTC-USD")]
    assert s[0]["name"] == "Nvidia" and s[0]["confidence"] == "Medium"
    assert s[0]["reasons"].startswith("Strong earnings")
    assert s[2]["reasons"] == ""  # next line is another signal
    assert s[1]["label"] == "DON'T BUY"


def test_match_symbols():
    quotes = [{"symbol": "BTC-USD", "name": "Bitcoin"}, {"symbol": "ASML.AS", "name": "ASML"},
              {"symbol": "NOVO-B.CO", "name": "Novo Nordisk"}]
    sigs = [{"symbol": "BTC", "name": ""}, {"symbol": "ASML", "name": ""},
            {"symbol": "NVO", "name": "Novo Nordisk"}, {"symbol": "XYZ", "name": ""}]
    match_symbols(sigs, quotes)
    assert [s["symbol"] for s in sigs] == ["BTC-USD", "ASML.AS", "NOVO-B.CO", "XYZ"]
