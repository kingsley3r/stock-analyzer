"""The morning digest: collect data -> ask Claude -> send to Telegram.

Run it:
    python -m analyzer.digest            # full run, sends to Telegram
    python -m analyzer.digest --no-send  # writes the digest but only prints it
    python -m analyzer.digest --dry-run  # only collects data (no AI cost, nothing sent)
    python -m analyzer.digest --backup   # only runs if today's digest wasn't sent yet
"""
from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from . import ai, news, prices, telegram, youtube
from .config import ROOT, load_dotenv, load_yaml, require_env

log = logging.getLogger("digest")
MAX_ARTICLES = 120


def collect(watchlist: dict, sources: dict) -> dict:
    snapshots = prices.fetch_snapshots(watchlist)
    articles = news.collect_news(sources, watchlist)[:MAX_ARTICLES]
    videos = youtube.collect_videos(sources)
    log.info("Collected %d price snapshots, %d articles, %d videos (%d with transcript)",
             len(snapshots), len(articles), len(videos), sum(1 for v in videos if v.transcript))
    return {
        "prices": [s.to_dict() for s in snapshots],
        "news": [a.to_dict() for a in articles],
        "youtube": [v.to_dict() for v in videos],
    }


def already_sent_today(now: datetime) -> bool:
    """True if the pinned message in the Telegram chat is from today (local time)."""
    try:
        pinned = telegram.pinned_message_time(require_env("TELEGRAM_BOT_TOKEN"), require_env("TELEGRAM_CHAT_ID"))
    except Exception as e:
        log.warning("Could not check whether today's digest was sent (%s); sending anyway", e)
        return False
    if pinned is None:
        return False
    return datetime.fromtimestamp(pinned, now.tzinfo).date() == now.date()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="collect data only; no AI call, nothing sent")
    parser.add_argument("--no-send", action="store_true", help="write the digest but don't send it")
    parser.add_argument("--backup", action="store_true",
                        help="skip if today's digest was already sent (used by the GitHub backup run)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
    load_dotenv()
    settings = load_yaml("settings.yaml")
    watchlist = load_yaml("watchlist.yaml")
    sources = load_yaml("sources.yaml")

    tz = ZoneInfo(settings.get("timezone", "Europe/Istanbul"))
    now = datetime.now(tz)
    out_dir = ROOT / "output"
    out_dir.mkdir(exist_ok=True)

    if args.backup and already_sent_today(now):
        log.info("Today's digest was already sent (by your computer). Backup run not needed.")
        return

    data = collect(watchlist, sources)
    data["generated_at"] = now.strftime("%A %d %B %Y, %H:%M (%Z)")
    (out_dir / f"data-{now:%Y-%m-%d}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    if args.dry_run:
        print(f"Dry run done. Data saved to output/data-{now:%Y-%m-%d}.json")
        return
    if not data["prices"] and not data["news"]:
        raise SystemExit("No prices and no news collected. Check your internet connection and the logs above.")

    require_env("ANTHROPIC_API_KEY")
    ai_cfg = settings.get("ai", {})
    body = ai.write_digest(data, model=ai_cfg.get("model", "claude-opus-5-5"), effort=ai_cfg.get("effort", "medium"))
    header = f"☀️ <b>Morning digest</b> · {now:%a %d %b}\n\n"
    digest = header + body
    (out_dir / f"digest-{now:%Y-%m-%d}.html").write_text(digest, encoding="utf-8")

    if args.no_send:
        print(digest)
        return
    token, chat_id = require_env("TELEGRAM_BOT_TOKEN"), require_env("TELEGRAM_CHAT_ID")
    message_ids = telegram.send_message(
        token, chat_id, digest, limit=settings.get("telegram", {}).get("max_message_length", 4000),
    )
    log.info("Digest sent to Telegram")
    try:
        telegram.pin_as_latest_digest(token, chat_id, message_ids[0])
    except Exception as e:  # pinning is nice to have; never fail the run over it
        log.warning("Could not pin the digest: %s", e)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Tell the user on their phone when something breaks, if Telegram is set up.
        token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
        if token and chat and not isinstance(e, SystemExit):
            try:
                telegram.send_message(token, chat, f"⚠️ Morning digest failed: {type(e).__name__}: {e}"[:1000])
            except Exception:
                pass
        raise
