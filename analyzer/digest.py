"""The morning digest: collect data -> ask Claude -> save to the app's inbox and notify your phone.

Run it:
    python -m analyzer.digest            # full run, notifies your phone
    python -m analyzer.digest --no-send  # writes the digest but only prints it
    python -m analyzer.digest --dry-run  # only collects data (no AI cost, nothing sent)
    python -m analyzer.digest --backup   # only runs if today's digest wasn't sent yet
"""
from __future__ import annotations

import argparse
import html
import json
import logging
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from . import ai, inbox, news, prices, youtube
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
    """True if today's digest is already in the inbox (record/inbox/)."""
    return inbox.sent_today("digest", now)


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
    digest = f"☀️ <b>Morning digest</b> · {now:%a %d %b}\n\n" + body
    (out_dir / f"digest-{now:%Y-%m-%d}.html").write_text(digest, encoding="utf-8")

    if args.no_send:
        print(digest)
        return
    # The digest is your morning alarm, so it notifies even inside your quiet time.
    inbox.notify("digest", f"☀️ Morning digest · {now:%a %d %b}", body)
    log.info("Digest saved to the inbox")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Tell you on your phone when something breaks.
        if not isinstance(e, SystemExit):
            try:
                inbox.notify("system", "⚠️ Morning digest failed", html.escape(f"{type(e).__name__}: {e}"[:1000]))
            except Exception:
                pass
        raise
