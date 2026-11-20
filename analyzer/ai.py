"""Sends the collected data to Claude and gets back the written digest."""
from __future__ import annotations

import json
import logging
import os

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
<, > or & in text as &lt; &gt; &amp;. Use short lines. Use emojis generously so the
briefing is easy to scan on a phone: a marker per section, 🟢/🔴 for up/down moves,
🔥 for big movers, 🤖 for AI news, ₿ for crypto, 🇺🇸/🇪🇺 for the market a line is about.

Structure:
1. 🌅 <b>Market overview</b>: 2-4 sentences on what moved markets and the mood (use the indices and VIX).
2. 📊 <b>Watchlist movers</b>: only the notable moves (big % change, unusual volume, RSI
   extremes, crossing the 50/200-day average), one line each starting with 🟢 or 🔴, with the
   number and the reason if the news explains it.
3. 📰 <b>Top news</b>: the 5-7 stories that matter most for his watchlist or the market, each
   one line with a fitting emoji and a link to the article.
4. 🎥 <b>YouTube pulse</b>: what the channels are saying, grouped by theme; note when several
   agree or disagree. Mention channel names. Base it on transcripts when present; when you only
   have a title, say so rather than guessing the content.
5. 🎯 <b>Today's signals</b>: 3-6 symbols where the evidence lines up. Give each one a clear,
   plain action label he can understand at a glance, using exactly one of:
     🟢 <b>BUY</b>: evidence points up and the setup looks attractive now
     🔴 <b>SELL</b>: if he holds it, consider taking profit or cutting the loss
     ⛔ <b>DON'T BUY</b>: looks risky or overheated; stay away for now
     🟡 <b>HOLD / WAIT</b>: mixed evidence; keep holding or wait for a clearer setup
     👀 <b>WATCH</b>: something is brewing; check it again later today
   Use the exact symbol from the data (e.g. BTC-USD, ASML.AS), not a shortened one.
   Format each signal like this (one blank line between signals):
     🟢 <b>BUY: NVDA</b> (Nvidia) · Confidence: ⭐⭐ Medium
     ➜ Strong earnings beat 📰 · YouTube channels bullish 🎥 · back above 50-day average 📈
   Confidence is ⭐ Low, ⭐⭐ Medium or ⭐⭐⭐ High. The reasons line has 2-3 short points from
   news, YouTube sentiment and technicals. Use HOLD / WAIT or WATCH when the evidence is
   mixed; a BUY or SELL needs at least two independent reasons. Never invent facts or
   numbers that are not in the data.
6. ⏰ <b>Today</b>: key times in Istanbul time (EU open, US open at 9:30 New York time,
   scheduled events mentioned in the news) and what to watch.
7. End with one short italic line: ⚠️ signals are not financial advice and can be wrong.

Keep the whole briefing under 3500 characters. Be direct and specific; skip filler."""


def make_client() -> anthropic.Anthropic:
    # The client reads ANTHROPIC_API_KEY from the environment. Some API keys belong to
    # the whole organization rather than one workspace; those also need the workspace id.
    workspace_id = os.environ.get("ANTHROPIC_WORKSPACE_ID", "").strip()
    if workspace_id and not workspace_id.startswith("wrkspc_"):
        raise SystemExit(
            "ANTHROPIC_WORKSPACE_ID looks wrong: a workspace id starts with 'wrkspc_'. "
            "Copy it from Claude Console > Settings > Workspaces (not the workspace name)."
        )
    headers = {"anthropic-workspace-id": workspace_id} if workspace_id else None
    return anthropic.Anthropic(default_headers=headers)


ALERT_PROMPT = """You explain breaking market news to a private investor (long-term, starting to day trade).
For each headline, write:
- summary: 1 to 3 short, plain-English sentences on what happened. Use only the headline and
  feed text given; if they say little, say so briefly instead of guessing details.
- impact: "up" if the news is more likely to push this stock's price up, "down" if more likely
  down, "unclear" if mixed or too early to tell.
- why: one short sentence explaining the likely effect on the stock.
Be honest about uncertainty. This is analysis, not financial advice."""

ALERT_SCHEMA = {
    "type": "object",
    "properties": {"alerts": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "summary": {"type": "string"},
            "impact": {"type": "string", "enum": ["up", "down", "unclear"]},
            "why": {"type": "string"},
        },
        "required": ["id", "summary", "impact", "why"],
        "additionalProperties": False,
    }}},
    "required": ["alerts"],
    "additionalProperties": False,
}


def explain_alerts(items: list[dict], model: str, effort: str = "low") -> dict[str, dict]:
    """Short summary + likely price effect for each news alert. Returns {id: {...}}."""
    client = make_client()
    request = dict(
        model=model,
        max_tokens=4000,
        system=ALERT_PROMPT,
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": ALERT_SCHEMA}},
        messages=[{"role": "user", "content": json.dumps({"headlines": items}, ensure_ascii=False)}],
    )
    if model.startswith(("claude-opus-5", "claude-sonnet-5-5", "claude-fable")):
        response = client.beta.messages.create(
            **request, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
    else:
        response = client.messages.create(**request)
    if response.stop_reason != "end_turn":
        raise RuntimeError(f"No alert explanations (stop_reason={response.stop_reason})")
    text = next(b.text for b in response.content if b.type == "text")
    log.info("Alert explanations: %s in, %s out tokens", response.usage.input_tokens, response.usage.output_tokens)
    return {a["id"]: a for a in json.loads(text)["alerts"]}


def write_digest(payload: dict, model: str, effort: str = "medium") -> str:
    return write_text(SYSTEM_PROMPT, payload, model, effort, what="the digest")


def write_text(system: str, payload: dict, model: str, effort: str = "medium", what: str = "the text") -> str:
    """Sends the data as JSON with the given instructions; returns Claude's text."""
    client = make_client()
    user_content = "Here is today's data:\n\n" + json.dumps(payload, ensure_ascii=False, indent=1)
    log.info("Asking %s for %s (%d characters of input)", model, what, len(user_content))

    request = dict(
        model=model,
        max_tokens=16000,
        system=system,
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
        raise RuntimeError(f"Claude declined to write {what}")
    text = "".join(block.text for block in response.content if block.type == "text").strip()
    if not text:
        raise RuntimeError(f"Empty response from Claude (stop_reason={response.stop_reason})")
    usage = response.usage
    log.info("Tokens used: %s in, %s out", usage.input_tokens, usage.output_tokens)
    return text
