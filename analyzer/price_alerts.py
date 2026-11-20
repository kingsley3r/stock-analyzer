"""Price alerts on your phone (and in the 🔔 inbox), checked with every dashboard update (every 15 min).

Two kinds:
- your own targets, set in the app on a stock's page (🔔), e.g. "tell me when
  NVDA goes above 200". The app saves them encrypted with your dashboard
  password in config/price_alerts.json, so they stay private;
- big moves: any watchlist stock moving more than `move_pct` % today
  (coins: `crypto_move_pct` %). Set in the app under ⚙️ Settings.

Each alert fires once: targets once ever (delete or change it in the app to
re-arm it), big moves once per symbol, direction and day. What already fired
is remembered in record/price_alerts.json (as unreadable fingerprints). Prices are from Yahoo Finance and
can be up to 15 minutes delayed. Free: no AI is used.
"""
from __future__ import annotations

import html
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import inbox
from .news_alerts import quiet_now

log = logging.getLogger(__name__)
TZ = ZoneInfo("Europe/Istanbul")


def target_id(a: dict) -> str:
    side = "above" if "above" in a else "below"
    return _fp(f"{a['symbol']}|{side}|{float(a[side]):g}")


def _fp(text: str) -> str:
    """Short fingerprint, so the public record branch doesn't show your targets."""
    import hashlib
    return hashlib.sha1(text.encode()).hexdigest()[:12]


def check(quotes: list[dict], cfg: dict, fired: dict, today: str) -> list[tuple[str, dict, str]]:
    """Returns (id, quote, kind, details) for every alert that should fire now."""
    by_symbol = {q["symbol"]: q for q in quotes}
    out = []
    for a in cfg.get("targets") or []:
        q = by_symbol.get(str(a.get("symbol")))
        if not q or q.get("last") is None or target_id(a) in fired:
            continue
        if ("above" in a and q["last"] >= float(a["above"])) or ("below" in a and q["last"] <= float(a["below"])):
            out.append((target_id(a), q, "above" if "above" in a else "below", a))
    move_pct, crypto_pct = float(cfg.get("move_pct", 5)), float(cfg.get("crypto_move_pct", 8))
    if cfg.get("moves_enabled", True):
        for q in quotes:
            ch = q.get("change_1d")
            if ch is None or q.get("group") == "index":
                continue
            limit = crypto_pct if q.get("group") == "crypto" else move_pct
            if abs(ch) >= limit:
                # Keyed on the price's own date, so yesterday's move doesn't fire again after midnight.
                key = _fp(f"{q['symbol']}|move|{'up' if ch > 0 else 'down'}|{q.get('last_date') or today}")
                if key not in fired:
                    out.append((key, q, "move", {"limit": limit}))
    return out


def fmt_price(q: dict) -> str:
    return f"{q.get('currency') or ''}{q['last']:,.2f}"


def format_alert(q: dict, kind: str, a: dict) -> str:
    e = html.escape
    name, sym = e(q["name"]), e(q["symbol"])
    ch = q.get("change_1d")
    move = "" if ch is None else f" {'🟢' if ch >= 0 else '🔴'} {ch:+.1f}% today"
    if kind == "move":
        icon = "🚀" if ch > 0 else "💥"
        head = f"{icon} <b>BIG MOVE · {sym} {ch:+.1f}%</b>"
        body = f"{name} moved more than {a['limit']:g}% today."
    else:
        icon = "🎯"
        word = "above" if kind == "above" else "below"
        head = f"{icon} <b>PRICE ALERT · {sym}</b>"
        target = f"{q.get('currency') or ''}{float(a[kind]):,.2f}"
        body = f"{name} is now {word} your target of {target}."
    return "\n".join([head, "━━━━━━━━━━━━━━", f"<b>{name}</b> · {fmt_price(q)}{move}", f"🔔 {e(body)}",
                      "🕒 Prices can be up to 15 min delayed"])


def load_config(password: str | None) -> dict:
    from .config import CONFIG_DIR, load_yaml
    from .lock import load_sealed_file
    cfg = {"moves_enabled": True, "move_pct": 5, "crypto_move_pct": 8, "targets": []}
    cfg.update(load_yaml("settings.yaml").get("price_alerts") or {})
    cfg.update(load_sealed_file(CONFIG_DIR / "price_alerts.json", password) or {})
    return cfg


def run(quotes: list[dict], cfg: dict, quiet_cfg: dict, state_file: Path) -> int:
    if cfg.get("enabled", True) is False:
        return 0
    fired = json.loads(state_file.read_text()) if state_file.exists() else {}
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    hits = check(quotes, cfg, fired, today)
    if not hits:
        return 0
    silent = quiet_now(quiet_cfg, "Europe/Istanbul")
    if silent and quiet_cfg.get("quiet_mode") == "skip":
        log.info("Price alerts: quiet time, not sending")
        return 0
    for key, q, kind, a in hits[:5]:
        title, body = inbox.split_head(format_alert(q, kind, a))
        inbox.notify("move" if kind == "move" else "price", title, body, symbol=q["symbol"], push=not silent,
                     links=[{"text": "📊 Open chart", "url": f"#/s/{q.get('file', '')}"}])
        fired[key] = today
    # Big-move keys are kept 5 days; targets stay until removed in the app.
    active = {target_id(a) for a in cfg.get("targets") or []}
    cutoff = (datetime.now(TZ) - timedelta(days=5)).strftime("%Y-%m-%d")
    fired = {k: v for k, v in fired.items() if v >= cutoff or k in active}
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(fired, sort_keys=True))
    log.info("Price alerts: sent %d", len(hits[:5]))
    return len(hits[:5])


def status(cfg: dict, state_file: Path) -> list[dict]:
    """Targets with a 'fired' flag, for the app."""
    fired = json.loads(state_file.read_text()) if state_file.exists() else {}
    return [{**a, "fired": target_id(a) in fired} for a in cfg.get("targets") or []]
