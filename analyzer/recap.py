"""Evening recap: a short Telegram message right after the US market closes
(00:15 Istanbul in winter, 23:15 in summer), covering what moved today and why,
the paper-trading account and earnings coming up.

Runs from .github/workflows/evening-recap.yml on weekdays. Uses Claude
(about $0.10 per recap). Turn it off with `evening_recap: enabled: false`
in config/settings.yaml.

    python -m analyzer.recap --no-send   # print it instead of sending
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import ai, news, paper, prices, telegram, track_record
from .dashboard_data import currency_for
from .config import ROOT, load_dotenv, load_yaml, require_env

log = logging.getLogger("recap")
TZ = ZoneInfo("Europe/Istanbul")

PROMPT = """\
You write a short evening recap for one private investor in Istanbul, sent right after the
US stock market closed. He is a long-term investor starting to day trade US, European stocks
and crypto. He reads it on his phone, often the next morning.

You get JSON with: today's price changes for his watchlist, news headlines from
the last 14 hours, a paper-trading account that follows the
app's signals, and upcoming earnings.

Write Telegram HTML; only <b>, <i>, <a href="..."> tags. Escape literal <, >, & as &lt; &gt; &amp;.
Short lines, emojis to make it scannable (🟢/🔴 for up/down, 🇺🇸/🇪🇺/₿ for the market).

Structure:
🌙 <b>Evening recap</b> · weekday and date
1. 📊 <b>The day in one look</b>: 2-3 sentences on how US and European markets closed and why.
2. 🔥 <b>Biggest moves</b>: the 3-6 most notable watchlist moves, one line each:
   "🟢 NVDA +4.1%: reason from the news" (say "no clear news" when there is none).
3. 🧪 <b>Paper trading</b>: account value and total profit or loss, open positions count,
   any trades today. One or two lines.
4. 📅 <b>Coming up</b>: earnings in the next 3 days and anything the news says is scheduled.
5. One short italic closing line: ⚠️ not financial advice.

Never invent numbers that are not in the data. Keep it under 1800 characters."""


def gather() -> dict:
    password = os.environ.get("DASHBOARD_PASSWORD", "").strip() or None
    watchlist = load_yaml("watchlist.yaml")
    sources = load_yaml("sources.yaml")
    settings = load_yaml("settings.yaml")
    price_list = watchlist

    quotes, candles_by_symbol = [], {}
    for entry, df in prices.download_history(price_list, "6mo"):
        snap = prices.snapshot_from_history(entry, df)
        if not snap:
            continue
        candles_by_symbol[entry[0]] = [[ts.strftime("%Y-%m-%d"), 0, 0, 0, round(float(r.Close), 4), 0]
                                       for ts, r in df.iterrows()]
        q = snap.to_dict()
        q["currency"] = currency_for(entry[0], entry[2])
        quotes.append(q)

    articles = [a for a in news.collect_news(sources, watchlist) if time.time() - a.published < 14 * 3600][:60]
    record_dir = ROOT / "record"
    entries = track_record.load_log(record_dir / "signals.json", password) if (record_dir / "signals.json").exists() else []
    paper_result = paper.simulate(entries, candles_by_symbol, settings.get("paper_trading"))
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    cal = json.loads((record_dir / "earnings.json").read_text()) if (record_dir / "earnings.json").exists() else {}
    return {
        "date": datetime.now(TZ).strftime("%A %d %B %Y"),
        "prices": [{k: q[k] for k in ("symbol", "name", "group", "last", "change_1d", "change_5d", "rsi14", "tags")}
                   for q in quotes],
        "news": [{"source": a.source, "title": a.title, "symbol": a.symbol, "link": a.link} for a in articles],
        "paper_trading": {k: paper_result[k] for k in ("total", "pnl", "pnl_pct", "cash", "closed", "win_rate")}
                         | {"open_positions": len(paper_result["positions"]),
                            "trades_today": [t for t in paper_result["trades"] if t["exit_date"] == today]},
        "earnings": [e for e in cal.get("events", []) if e["date"] >= today][:10],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-send", action="store_true", help="print instead of sending")
    args = parser.parse_args()
    load_dotenv()
    cfg = load_yaml("settings.yaml").get("evening_recap") or {}
    if cfg.get("enabled", True) is False:
        log.info("Evening recap is turned off in settings.yaml")
        return
    data = gather()
    text = ai.write_text(PROMPT, data, cfg.get("model", "claude-opus-5-5"), cfg.get("effort", "medium"))
    if args.no_send:
        print(text)
        return
    token, chat_id = require_env("TELEGRAM_BOT_TOKEN"), require_env("TELEGRAM_CHAT_ID")
    for part in telegram.split_message(text):
        telegram._call(token, "sendMessage", chat_id=chat_id, text=part, parse_mode="HTML",
                       disable_notification=bool(cfg.get("silent", True)),
                       link_preview_options={"is_disabled": True})
    log.info("Evening recap sent (%d characters)", len(text))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
    main()
