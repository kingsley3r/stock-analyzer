from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from analyzer import digest, inbox

TZ = ZoneInfo("Europe/Istanbul")


def test_backup_skips_when_digest_in_inbox_today(tmp_path, monkeypatch):
    monkeypatch.setenv("RECORD_DIR", str(tmp_path))
    monkeypatch.delenv("RECORD_FILE", raising=False)
    monkeypatch.setenv("DASHBOARD_PASSWORD", "pw")
    now = datetime.now(TZ)
    assert digest.already_sent_today(now) is False
    inbox.notify("digest", "☀️ Morning digest", "hello", push=False, now=now - timedelta(days=1))
    assert digest.already_sent_today(now) is False
    inbox.notify("news", "📰 News", "x", push=False, now=now)
    assert digest.already_sent_today(now) is False
    inbox.notify("digest", "☀️ Morning digest", "hello", push=False, now=now)
    assert digest.already_sent_today(now) is True
