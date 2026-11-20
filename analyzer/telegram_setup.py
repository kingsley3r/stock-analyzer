"""Helper to find your Telegram chat id.

1. Create a bot with @BotFather in Telegram and copy the token into .env.
2. Open your new bot in Telegram and send it any message (e.g. "hi").
3. Run:  python -m analyzer.telegram_setup
"""
import requests

from .config import load_dotenv, require_env
from .telegram import API, send_message


def main() -> None:
    load_dotenv()
    token = require_env("TELEGRAM_BOT_TOKEN")
    data = requests.get(API.format(token=token, method="getUpdates"), timeout=30).json()
    if not data.get("ok"):
        raise SystemExit(f"Telegram says: {data}")
    chats = {u["message"]["chat"]["id"]: u["message"]["chat"].get("first_name", "")
             for u in data["result"] if "message" in u}
    if not chats:
        raise SystemExit("No messages found. Send your bot a message in Telegram first, then run this again.")
    for chat_id, name in chats.items():
        print(f"Chat id for {name}: {chat_id}")
        send_message(token, str(chat_id), "✅ Your stock analyzer bot is connected.")
    print("Put this number in .env as TELEGRAM_CHAT_ID (and in the GitHub secrets).")


if __name__ == "__main__":
    main()
