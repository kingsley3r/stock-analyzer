"""Sends the collected data to Claude and gets back the written digest."""
from __future__ import annotations

import json
import logging

import anthropic

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are a market analyst writing a personal morning briefing for one private investor
in Istanbul (Europe/Istanbul time). He holds long-term positions, is starting to day trade
US stocks, European stocks and crypto, and trades through flatex. He makes every decision
himself; you give him well-reasoned signals, not orders.

You get JSON with: price snapshots for his watchlist (daily % changes, RSI14, distance
from the 50- and 200-day averages, volume vs. the 20-day average), the last 24 hours of
news headlines, and new videos (title, description, sometimes a transcript) from finance
YouTube channels.

Write the briefing in English, as Telegram HTML. You may only use these tags:
<b>, <i>, <a href="...">. No other tags, no Markdown, no tables. Escape any literal
<, > or & in text as &lt; &gt; &amp;. Use short lines and a few emojis as section markers.

Structure:
1. 🌅 <b>Market overview</b>: 2-4 sentences on what moved markets and the mood (use the indices and VIX).
2. 📊 <b>Watchlist movers</b>: only the notable moves (big % change, unusual volume, RSI
   extremes, crossing the 50/200-day average), one line each with the number and the reason if the news explains it.
3. 📰 <b>Top news</b>: the 5-7 stories that matter most for his watchlist or the market, each
   one line with a link to the article.
4. 🎥 <b>YouTube pulse</b>: what the channels are saying, grouped by theme; note when several
   agree or disagree. Mention channel names. Base it on transcripts when present; when you only
   have a title, say so rather than guessing the content.
5. 🧭 <b>Signals</b>: 3-6 symbols where the evidence lines up. For each: Bullish / Bearish /
   Watch, a confidence of Low / Medium / High, and the reasons in one or two lines (news,
   sentiment, technicals). Prefer "Watch" when the evidence is mixed. Never invent facts or
   numbers that are not in the data.
6. ⏰ <b>Today</b>: key times in Istanbul time (EU open, US open at 9:30 New York time,
   scheduled events mentioned in the news) and what to watch.
7. End with one short italic line: signals are not financial advice and can be wrong.

Keep the whole briefing under 3500 characters. Be direct and specific; skip filler."""


def write_digest(payload: dict, model: str, effort: str = "medium") -> str:
    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    user_content = "Here is today's data:\n\n" + json.dumps(payload, ensure_ascii=False, indent=1)
    log.info("Asking %s for the digest (%d characters of input)", model, len(user_content))

    request = dict(
        model=model,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        output_config={"effort": effort},
        messages=[{"role": "user", "content": user_content}],
    )
    if model.startswith(("claude-opus-5", "claude-sonnet-5-5", "claude-fable")):
        # If the main model declines (rare), the API retries on a fallback model.
        response = client.beta.messages.create(
            **request, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
    else:
        response = client.messages.create(**request)

    if response.stop_reason == "refusal":
        raise RuntimeError("Claude declined to write the digest")
    text = "".join(block.text for block in response.content if block.type == "text").strip()
    if not text:
        raise RuntimeError(f"Empty response from Claude (stop_reason={response.stop_reason})")
    usage = response.usage
    log.info("Tokens used: %s in, %s out", usage.input_tokens, usage.output_tokens)
    return text
