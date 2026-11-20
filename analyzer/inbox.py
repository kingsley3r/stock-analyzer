"""Your in-app inbox (🔔 in the app) and iPhone notifications. Replaces Telegram.

Every alert, the morning digest and the evening recap are saved as one small
encrypted file in record/inbox/ (on the 'track-record' branch). Each dashboard
update collects the last 30 days into site/data/inbox.json, which the app shows
behind the bell icon. Older messages are deleted.

Notifications: in the app, ⚙️ Settings > "Turn on notifications" asks your
iPhone for permission and saves the phone's address for notifications,
encrypted with your password, in config/push/. We send with the free Web Push
standard (Apple delivers it). The signing key it needs ("VAPID") is calculated
from your DASHBOARD_PASSWORD, so there is no extra secret to set up. If you
change the password, turn notifications on again in the app.
"""
from __future__ import annotations

import base64
import hashlib
import html
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .config import CONFIG_DIR, ROOT
from .lock import Locker, load_sealed_file

log = logging.getLogger(__name__)
TZ = ZoneInfo("Europe/Istanbul")
KEEP_DAYS = 30
APP_URL = "https://kingsley3r.github.io/stock-analyzer/"
PUSH_DIR = CONFIG_DIR / "push"
_lockers: dict[str, Locker] = {}


def inbox_dir() -> Path:
    if os.environ.get("RECORD_FILE"):
        return Path(os.environ["RECORD_FILE"]).parent / "inbox"
    return Path(os.environ.get("RECORD_DIR", ROOT / "record")) / "inbox"


def _password(password: str | None = None) -> str | None:
    return password or os.environ.get("DASHBOARD_PASSWORD", "").strip() or None


def _locker(password: str) -> Locker:
    # One fixed salt for the inbox, so the slow password step runs once per update
    # instead of once per message. Every message still gets its own random IV.
    if password not in _lockers:
        _lockers[password] = Locker(password, salt=hashlib.sha256(b"market-pulse-inbox").digest()[:16])
    return _lockers[password]


def strip_tags(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text))


def split_head(text: str) -> tuple[str, str]:
    """'<b>HEADLINE</b>\\n━━━\\nbody' -> ('HEADLINE', 'body')."""
    lines = text.strip().split("\n")
    title = strip_tags(lines[0]).strip()
    rest = lines[1:]
    while rest and (not rest[0].strip() or set(rest[0].strip()) <= {"━", "─", "-"}):
        rest = rest[1:]
    return title, "\n".join(rest).strip()


def short_body(body_html: str, limit: int = 170) -> str:
    text = re.sub(r"\s*\n\s*", " · ", strip_tags(body_html)).strip(" ·")
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# --------------------------------------------------------------------------- inbox

def notify(kind: str, title: str, body_html: str, *, symbol: str | None = None,
           links: list[dict] | None = None, push: bool = True, password: str | None = None,
           now: datetime | None = None) -> dict:
    """Saves one message to the inbox and (if push) sends it to your phone.
    Never raises: a problem with notifications must not stop the run."""
    now = now or datetime.now(TZ)
    item = {"id": f"{now:%Y%m%d-%H%M%S}-{kind}-{secrets.token_hex(3)}",
            "ts": now.isoformat(timespec="seconds"), "kind": kind, "title": title,
            "html": body_html.strip(), "symbol": symbol, "links": links or []}
    pw = _password(password)
    folder = inbox_dir()
    folder.mkdir(parents=True, exist_ok=True)
    body = _locker(pw).seal(item) if pw else item
    if not pw:
        log.warning("DASHBOARD_PASSWORD is not set: inbox message saved unencrypted (fine on your computer only)")
    (folder / f"{item['id']}.json").write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
    if push:
        try:
            item["pushed"] = send_push(item, pw)
        except Exception as exc:  # noqa: BLE001
            log.warning("Notification failed: %s", exc)
    return item


def load_items(password: str | None = None, days: int = KEEP_DAYS) -> list[dict]:
    """The inbox, newest first."""
    pw = _password(password)
    folder = inbox_dir()
    if not folder.exists():
        return []
    cutoff = (datetime.now(TZ) - timedelta(days=days)).strftime("%Y%m%d")
    items = []
    for path in sorted(folder.glob("*.json"), reverse=True):
        if path.name[:8] < cutoff:
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        if "ct" in raw:
            if not pw:
                continue
            try:
                raw = _locker(pw).open(raw)
            except Exception:  # noqa: BLE001 - written with another password
                continue
        items.append(raw)
    return items


def prune(days: int = KEEP_DAYS) -> int:
    folder = inbox_dir()
    cutoff = (datetime.now(TZ) - timedelta(days=days)).strftime("%Y%m%d")
    old = [p for p in folder.glob("*.json") if p.name[:8] < cutoff] if folder.exists() else []
    for p in old:
        p.unlink()
    return len(old)


def sent_today(kind: str, now: datetime | None = None) -> bool:
    """True if a message of this kind was already saved today (Istanbul date)."""
    now = now or datetime.now(TZ)
    folder = inbox_dir()
    return folder.exists() and any(folder.glob(f"{now:%Y%m%d}-*-{kind}-*.json"))


# --------------------------------------------------------------------------- notifications

def _vapid_private(password: str):
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives import hashes
    seed = HKDF(algorithm=hashes.SHA256(), length=48, salt=b"market-pulse", info=b"web-push-vapid").derive(password.encode())
    n = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551  # order of the P-256 curve
    return ec.derive_private_key(int.from_bytes(seed, "big") % (n - 1) + 1, ec.SECP256R1())


def public_key(password: str | None = None) -> str | None:
    """The key the app needs to subscribe (safe to share; it can't send anything)."""
    from cryptography.hazmat.primitives import serialization
    pw = _password(password)
    if not pw:
        return None
    raw = _vapid_private(pw).public_key().public_bytes(serialization.Encoding.X962,
                                                       serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def subscriptions(password: str | None = None) -> list[dict]:
    pw = _password(password)
    subs = []
    for path in sorted(PUSH_DIR.glob("*.json")) if PUSH_DIR.exists() else []:
        sub = load_sealed_file(path, pw)
        if sub and sub.get("endpoint"):
            subs.append(sub)
    return subs


def fingerprint(sub: dict) -> str:
    return hashlib.sha1(sub["endpoint"].encode()).hexdigest()[:12]


def payload(item: dict) -> str:
    """What travels to the phone (max ~4 KB; end-to-end encrypted by Web Push)."""
    full = dict(item)
    full.pop("pushed", None)
    data = {"id": item["id"], "title": item["title"], "body": short_body(item["html"]),
            "url": f"#/inbox/{item['id']}", "item": full}
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode()) > 3000:  # too long (the digest): the app loads the full text a minute later
        data["item"] = None
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return text


def send_push(item: dict, password: str | None = None, only: list[dict] | None = None) -> int:
    from py_vapid import Vapid02
    from pywebpush import WebPushException, webpush
    pw = _password(password)
    if not pw:
        return 0
    subs = only if only is not None else subscriptions(pw)
    if not subs:
        log.info("No phone has notifications turned on yet (⚙️ Settings in the app)")
        return 0
    vapid = Vapid02(private_key=_vapid_private(pw))
    data, sent = payload(item), 0
    urgent = item["kind"] != "recap"
    for sub in subs:
        try:
            webpush({"endpoint": sub["endpoint"], "keys": sub["keys"]}, data=data, vapid_private_key=vapid,
                    vapid_claims={"sub": "https://kingsley3r.github.io", "exp": int(time.time()) + 12 * 3600}, ttl=12 * 3600, timeout=20,
                    headers={"Urgency": "high" if urgent else "normal"})
            sent += 1
        except WebPushException as exc:
            code = getattr(exc.response, "status_code", None)
            if code in (404, 410):
                log.warning("A phone's notification address expired. Turn notifications on again in the app.")
            else:
                log.warning("Notification to one phone failed: %s", exc)
    log.info("Notification sent to %d phone(s): %s", sent, item["title"])
    return sent


def welcome_new_phones(state_file: Path, password: str | None = None) -> int:
    """Sends a 'notifications are on' message to phones that just subscribed."""
    pw = _password(password)
    subs = subscriptions(pw)
    seen = json.loads(state_file.read_text()) if state_file.exists() else []
    new = [s for s in subs if fingerprint(s) not in seen]
    if not new:
        return 0
    item = notify("system", "✅ Notifications are on",
                  "You'll get your morning digest, alerts and the evening recap here. "
                  "Everything also stays in the 🔔 inbox in the app.", push=False, password=pw)
    sent = send_push(item, pw, only=new)
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(sorted({fingerprint(s) for s in subs})))
    return sent
