import time
from datetime import datetime
from zoneinfo import ZoneInfo

from analyzer import digest, telegram

TZ = ZoneInfo("Europe/Istanbul")


def _env(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "1")


def test_backup_skips_when_pinned_today(monkeypatch):
    _env(monkeypatch)
    now = datetime.now(TZ)
    monkeypatch.setattr(telegram, "pinned_message_time", lambda t, c: int(time.time()) - 60)
    assert digest.already_sent_today(now) is True


def test_backup_runs_when_pinned_yesterday_or_nothing(monkeypatch):
    _env(monkeypatch)
    now = datetime.now(TZ)
    monkeypatch.setattr(telegram, "pinned_message_time", lambda t, c: int(time.time()) - 2 * 86400)
    assert digest.already_sent_today(now) is False
    monkeypatch.setattr(telegram, "pinned_message_time", lambda t, c: None)
    assert digest.already_sent_today(now) is False


def test_backup_sends_if_check_fails(monkeypatch):
    _env(monkeypatch)

    def boom(t, c):
        raise RuntimeError("network down")
    monkeypatch.setattr(telegram, "pinned_message_time", boom)
    assert digest.already_sent_today(datetime.now(TZ)) is False
