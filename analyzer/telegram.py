"""Sends messages to your phone through a Telegram bot."""
from __future__ import annotations

import logging
import re

import requests

log = logging.getLogger(__name__)
API = "https://api.telegram.org/bot{token}/{method}"


def split_message(text: str, limit: int = 4000) -> list[str]:
    """Telegram allows max 4096 characters per message, so long text is split
    at paragraph breaks (or line breaks) to keep formatting tags intact."""
    if len(text) <= limit:
        return [text]
    parts, current = [], ""
    for para in re.split(r"(\n\n)", text):
        if len(current) + len(para) <= limit:
            current += para
            continue
        if current.strip():
            parts.append(current.strip())
        current = ""
        while len(para) > limit:  # a single huge paragraph: cut at a line break
            cut = para.rfind("\n", 0, limit)
            cut = cut if cut > 0 else limit
            parts.append(para[:cut].strip())
            para = para[cut:]
        current = para
    if current.strip():
        parts.append(current.strip())
    return parts


def strip_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text).replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def _call(token: str, method: str, **payload) -> dict:
    resp = requests.post(API.format(token=token, method=method), json=payload, timeout=30)
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    if not resp.ok or not data.get("ok"):
        raise RuntimeError(f"Telegram {method} error {resp.status_code}: {resp.text}")
    return data["result"]


def send_message(token: str, chat_id: str, text: str, limit: int = 4000) -> list[int]:
    """Sends the text (split if needed) and returns the ids of the sent messages."""
    message_ids = []
    for part in split_message(text, limit):
        payload = {"chat_id": chat_id, "text": part, "parse_mode": "HTML",
                   "link_preview_options": {"is_disabled": True}}
        resp = requests.post(API.format(token=token, method="sendMessage"), json=payload, timeout=30)
        if resp.status_code == 400 and "parse" in resp.text.lower():
            # The AI produced HTML Telegram doesn't accept: send it as plain text instead.
            log.warning("Telegram rejected the formatting, sending plain text: %s", resp.text)
            payload.pop("parse_mode")
            payload["text"] = strip_tags(part)
            resp = requests.post(API.format(token=token, method="sendMessage"), json=payload, timeout=30)
        if not resp.ok:
            raise RuntimeError(f"Telegram error {resp.status_code}: {resp.text}")
        message_ids.append(resp.json()["result"]["message_id"])
    return message_ids


def pin_as_latest_digest(token: str, chat_id: str, message_id: int) -> None:
    """Pins today's digest at the top of the chat (and unpins older ones).
    The pin also works as a marker that today's digest was sent, so the
    GitHub backup run can see it and skip."""
    _call(token, "unpinAllChatMessages", chat_id=chat_id)
    _call(token, "pinChatMessage", chat_id=chat_id, message_id=message_id, disable_notification=True)


def pinned_message_time(token: str, chat_id: str) -> int | None:
    """Unix time of the currently pinned message, or None if nothing is pinned."""
    pinned = _call(token, "getChat", chat_id=chat_id).get("pinned_message")
    return pinned.get("date") if pinned else None
