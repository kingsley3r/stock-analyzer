import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from analyzer import inbox

TZ = ZoneInfo("Europe/Istanbul")


@pytest.fixture
def box(tmp_path, monkeypatch):
    monkeypatch.setenv("RECORD_DIR", str(tmp_path))
    monkeypatch.delenv("RECORD_FILE", raising=False)
    monkeypatch.setenv("DASHBOARD_PASSWORD", "secret pw")
    monkeypatch.setattr(inbox, "PUSH_DIR", tmp_path / "push")
    return tmp_path / "inbox"


def test_messages_are_encrypted_and_read_back(box):
    now = datetime.now(TZ)
    inbox.notify("news", "📈 LIKELY UP · NVDA", "<b>Nvidia</b> beats", symbol="NVDA", push=False, now=now)
    inbox.notify("recap", "🌙 Evening recap", "day", push=False, now=now + timedelta(minutes=1))
    files = list(box.glob("*.json"))
    assert len(files) == 2 and all("ct" in json.loads(f.read_text()) for f in files)
    assert "Nvidia" not in "".join(f.read_text() for f in files)
    items = inbox.load_items()
    assert [i["kind"] for i in items] == ["recap", "news"] and items[1]["symbol"] == "NVDA"
    assert inbox.load_items("wrong password") == []


def test_prune_keeps_30_days(box):
    now = datetime.now(TZ)
    inbox.notify("news", "old", "x", push=False, now=now - timedelta(days=40))
    inbox.notify("news", "new", "x", push=False, now=now)
    assert inbox.prune() == 1
    assert [i["title"] for i in inbox.load_items()] == ["new"]


def test_split_head_and_short_body():
    title, body = inbox.split_head("🎯 <b>PRICE ALERT · NVDA</b>\n━━━━━━\n<b>Nvidia</b> · $200\n🔔 above")
    assert title == "🎯 PRICE ALERT · NVDA" and body == "<b>Nvidia</b> · $200\n🔔 above"
    assert inbox.short_body(body) == "Nvidia · $200 · 🔔 above"
    assert len(inbox.short_body("x" * 500)) == 170


def test_vapid_key_is_stable_and_valid():
    k1, k2 = inbox.public_key("pw"), inbox.public_key("pw")
    assert k1 == k2 and k1 != inbox.public_key("other")
    import base64
    raw = base64.urlsafe_b64decode(k1 + "=" * (-len(k1) % 4))
    assert len(raw) == 65 and raw[0] == 4


def test_push_payload_small_enough():
    item = {"id": "x", "kind": "digest", "title": "☀️ Morning digest", "html": "a" * 10000, "links": []}
    data = json.loads(inbox.payload(item))
    assert data["item"] is None and data["url"] == "#/inbox/x" and len(data["body"]) <= 170
    item["html"] = "short"
    assert json.loads(inbox.payload(item))["item"]["html"] == "short"


def test_push_is_sent_to_saved_phones(box, monkeypatch):
    import pywebpush
    from analyzer.lock import Locker
    lk = Locker("secret pw")
    (box.parent / "push").mkdir()
    sub = {"endpoint": "https://web.push.apple.com/abc", "keys": {"p256dh": "k", "auth": "a"}}
    (box.parent / "push" / "phone.json").write_text(json.dumps({**lk.header(), **lk.seal(sub)}))
    sent = []
    monkeypatch.setattr(pywebpush, "webpush", lambda info, **kw: sent.append((info, kw)))
    item = inbox.notify("price", "🎯 PRICE ALERT · NVDA", "Nvidia above 200")
    assert item["pushed"] == 1 and sent[0][0]["endpoint"] == sub["endpoint"]
    assert json.loads(sent[0][1]["data"])["title"] == "🎯 PRICE ALERT · NVDA"
    # The first time a phone appears, it gets a welcome message once.
    state = box.parent / "phones.json"
    assert inbox.welcome_new_phones(state) == 1 and inbox.welcome_new_phones(state) == 0
