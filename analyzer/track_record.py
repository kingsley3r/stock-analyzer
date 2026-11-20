"""Signal track record: did the AI's calls turn out right?

Every day's signals are saved with the price at that moment (the last closing
price before the signal). Later we look at what the price did after 1 day,
1 week and 1 month:

  BUY                 counts as right if the price went UP after 1 week
  SELL / DON'T BUY    counts as right if the price went DOWN after 1 week
  HOLD / WAIT, WATCH  are shown, but not scored (they don't predict a direction)

The log is stored encrypted (with your dashboard password) in the file
signals.json on the separate 'track-record' branch of the repository."""
from __future__ import annotations

import base64
import json
import logging
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from cryptography.exceptions import InvalidTag

from .lock import Locker

log = logging.getLogger(__name__)
TZ = ZoneInfo("Europe/Istanbul")
HORIZONS = {"1d": 1, "1w": 5, "1m": 21}   # in trading days (candles)
SCORE_ON = "1w"
SCORED = {"buy": 1, "sell": -1, "avoid": -1}  # expected direction


# --------------------------------------------------------------------------- storage

def load_log(path: Path, password: str | None) -> list[dict]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if "ct" not in raw:          # unencrypted (local use without a password)
        return raw.get("signals", [])
    if not password:
        raise SystemExit("The track record is encrypted, set DASHBOARD_PASSWORD to read it.")
    try:
        locker = Locker(password, salt=base64.b64decode(raw["salt"]))
        return locker.open(raw)["signals"]
    except InvalidTag:
        # The password was changed. Keep the old file instead of overwriting it.
        backup = path.with_name(f"signals-old-password-{datetime.now(TZ):%Y%m%d%H%M}.json")
        path.rename(backup)
        log.warning("Could not unlock the track record (password changed?). Kept it as %s and started a new one.", backup.name)
        return []


def save_log(path: Path, signals: list[dict], password: str | None) -> None:
    body = {"signals": signals}
    if password:
        locker = Locker(password)
        body = {**locker.header(), **locker.seal(body)}
    path.write_text(json.dumps(body, ensure_ascii=False, indent=None), encoding="utf-8")


# --------------------------------------------------------------------------- recording

def record_digest(entries: list[dict], digest: dict | None, quotes: list[dict]) -> list[dict]:
    """Adds today's signals to the log (one set per day: a later digest on the
    same day replaces the earlier one). Returns the updated list."""
    if not digest or not digest.get("signals"):
        return entries
    sent = datetime.fromisoformat(digest["sent_at"]).astimezone(TZ)
    day = sent.strftime("%Y-%m-%d")
    by_symbol = {q["symbol"]: q for q in quotes}

    same_day = [e for e in entries if e["date"] == day]
    if same_day and same_day[0].get("sent_at") == digest["sent_at"]:
        return entries  # already recorded this digest

    kept = [e for e in entries if e["date"] != day]
    for s in digest["signals"]:
        q = by_symbol.get(s["symbol"])
        if not q:
            continue  # not on the watchlist, so no price to measure against
        kept.append({
            "date": day,
            "sent_at": digest["sent_at"],
            "symbol": s["symbol"],
            "name": s.get("name") or q["name"],
            "action": s["action"],
            "label": s["label"],
            "confidence": s.get("confidence", ""),
            "reasons": s.get("reasons", ""),
            "entry_date": q["last_date"],   # the close the signal was based on
            "entry_price": q["last"],
        })
    log.info("Track record: saved %d signals for %s", sum(1 for e in kept if e["date"] == day), day)
    return sorted(kept, key=lambda e: (e["date"], e["symbol"]))


# --------------------------------------------------------------------------- scoring

def evaluate(entries: list[dict], candles_by_symbol: dict[str, list]) -> dict:
    """Adds the price change after each horizon and a right/wrong result."""
    items = []
    for e in entries:
        item = dict(e)
        candles = candles_by_symbol.get(e["symbol"], [])
        dates = [c[0] for c in candles]
        # Position of the entry candle (the last one on or before the entry date).
        idx = max((i for i, d in enumerate(dates) if d <= e["entry_date"]), default=None)
        entry = e.get("entry_price") or (candles[idx][4] if idx is not None else None)
        item["entry_price"] = entry
        for name, n in HORIZONS.items():
            later = idx + n if idx is not None else None
            item[name] = (round((candles[later][4] / entry - 1) * 100, 2)
                          if entry and later is not None and later < len(candles) else None)
        direction = SCORED.get(e["action"])
        change = item[SCORE_ON]
        if direction is None:
            item["result"] = "info"
        elif change is None:
            item["result"] = "pending"
        else:
            item["result"] = "right" if change * direction > 0 else "wrong"
        items.append(item)

    def summary(actions: set[str]) -> dict:
        done = [i for i in items if i["action"] in actions and i["result"] in ("right", "wrong")]
        right = sum(1 for i in done if i["result"] == "right")
        return {
            "scored": len(done),
            "right": right,
            "hit_rate": round(right / len(done) * 100) if done else None,
            "avg_change": round(sum(i[SCORE_ON] for i in done) / len(done), 2) if done else None,
            "pending": sum(1 for i in items if i["action"] in actions and i["result"] == "pending"),
        }

    return {
        "score_on": SCORE_ON,
        "buy": summary({"buy"}),
        "sell": summary({"sell", "avoid"}),
        "total": len(items),
        "since": items[0]["date"] if items else None,
        "items": sorted(items, key=lambda i: (i["date"], i["symbol"]), reverse=True),
    }
