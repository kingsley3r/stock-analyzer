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


def send_message(token: str, chat_id: str, text: str, limit: int = 4000) -> None:
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
