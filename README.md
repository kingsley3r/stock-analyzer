# Stock Analyzer

A personal AI market analyst. Every morning at about **06:00 Istanbul time** it:

1. downloads prices for your watchlist (US stocks, European stocks, crypto, major indices),
2. reads the last 24 hours of financial news (CNBC, MarketWatch, Yahoo Finance, FT headlines, CoinDesk and more),
3. checks new videos from finance and crypto YouTube channels, reading the transcripts when it can,
4. asks Claude to turn all of that into a short briefing with **signals and reasons**,
5. sends the briefing to your iPhone through **Telegram**.

> ⚠️ The signals are analysis, not financial advice. They can be wrong. You make every decision.

This is **milestone 1** of the plan. Next come a web dashboard with charts, signals with a
track record, and a day-trading mode.

---

## How it works (the big picture)

```
config/*.yaml ──► prices.py   (Yahoo Finance)  ─┐
                  news.py     (RSS feeds)       ├─► digest.py ──► ai.py (Claude) ──► telegram.py ──► 📱
                  youtube.py  (YouTube feeds)  ─┘
```

| File | What it does |
|---|---|
| `config/watchlist.yaml` | Your stocks and coins. **Edit this to add or remove symbols.** |
| `config/sources.yaml` | News feeds and YouTube channels. **Add your own channels here.** |
| `config/settings.yaml` | Which Claude model to use, time zone. |
| `analyzer/indicators.py` | Simple maths: % change, moving averages, RSI, volume. Good file to read first. |
| `analyzer/prices.py` | Downloads one year of daily prices and builds a "snapshot" per symbol. |
| `analyzer/news.py` | Reads RSS feeds, keeps the last 24 h, removes duplicates. |
| `analyzer/youtube.py` | Finds new videos per channel and grabs transcripts. |
| `analyzer/ai.py` | The instructions for Claude (the "system prompt") and the API call. |
| `analyzer/telegram.py` | Sends the message, splitting it if it is too long. |
| `analyzer/digest.py` | The main program that runs all steps in order. |
| `.github/workflows/morning-digest.yml` | Tells GitHub to run the digest every morning for free. |

---

## Setup (one time, about 20 minutes)

You need three secret values. Keep them private: anyone with them can use your accounts.

### 1. Telegram bot (free)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Choose a name (e.g. "My Market Digest") and a username ending in `bot`.
3. BotFather replies with a **token** like `123456789:ABCdef...`. That is `TELEGRAM_BOT_TOKEN`.
4. Open your new bot (tap the link BotFather gives you) and send it any message, e.g. "hi".
5. Your **chat id** is found in step 4 of "Run it on your computer" below.

### 2. Claude API key (pay per use)

1. Go to <https://console.anthropic.com>, sign up, and add a payment method under **Billing**.
   Set a monthly spend limit (e.g. $20) so there are no surprises.
2. Under **API Keys**, create a key. That is `ANTHROPIC_API_KEY` (starts with `sk-ant-`).

Expected cost: roughly $0.10 to $0.40 per digest with the default model, so about $3 to $12 a month.
To pay less, set `model: claude-haiku-5-5` in `config/settings.yaml`.

### 3. Add the secrets to GitHub

In your repository on github.com: **Settings → Secrets and variables → Actions → New repository secret**.
Add the three secrets: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

If a run fails with *"This API key is not scoped to a workspace"*, also add `ANTHROPIC_WORKSPACE_ID`:
in the Claude Console open **Settings → Workspaces**, open your workspace (e.g. "Default"),
and copy its id (starts with `wrkspc_`).

Then go to the **Actions** tab → **Morning digest** → **Run workflow** to test it right away.
After that it runs by itself every morning.

---

## Dashboard (web app for your iPhone)

**Address:** <https://kingsley3r.github.io/stock-analyzer/>

Four tabs: **Today** (signals, biggest moves, the morning briefing), **Watchlist** (every
symbol with a 30-day mini chart; tap one for a full chart with 50- and 200-day averages),
**News** (filter by your stocks, AI, crypto) and **Videos** (new videos from your channels).
It updates every 30 minutes and right after each morning digest.

**One-time setup:**
1. In the repository on github.com open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Add a repository secret named `DASHBOARD_PASSWORD` (Settings → Secrets and variables → Actions)
   with a password of your choice. Use a long one; it protects your data.
3. Open the **Actions** tab → **Dashboard** → **Run workflow**.

**Private by password:** all data on the website is encrypted (AES-256) with your password.
The page asks for it once, and your phone can remember it. Without the password, visitors see
only a lock screen. To change the password, update the secret and run the Dashboard workflow.

**Install on iPhone:** open the address in Safari, tap **Share ⬆️ → Add to Home Screen**.
It then opens full-screen like a normal app.

> Note: the code and `config/watchlist.yaml` are visible in this public repository. The
> dashboard data (briefing, signals, news) is encrypted. Your API keys are never visible.

How it is built:

| File | What it does |
|---|---|
| `analyzer/dashboard_data.py` | Collects prices (2 years, for charts), news, videos and reads today's pinned digest from Telegram. Writes `site/data/*.json`. |
| `site/index.html` | The page skeleton: top bar, content area, bottom tabs, and the lines that make it installable. |
| `site/styles.css` | All colors and layout. Light and dark mode follow your iPhone setting. |
| `site/app.js` | Unlocks and loads the data and draws each tab. Read the comments at the top first. |
| `analyzer/lock.py` | Encrypts the data with your password before it is published. |
| `site/vendor/` | The chart library (TradingView Lightweight Charts, free and open source). |
| `.github/workflows/dashboard.yml` | Rebuilds the data every 30 minutes and publishes the site. |

To preview it on your computer: run `python -m analyzer.dashboard_data` (without a password set it
writes unlocked files, fine for local use), then
`cd site && python -m http.server 8000`, and open <http://localhost:8000>.

---

## Get YouTube transcripts: run it on your home computer

YouTube blocks GitHub's servers from reading video transcripts. To get the full YouTube
insights, schedule the digest on your home computer. GitHub then stays as a backup.
Step-by-step guide: **[docs/HOME_SETUP.md](docs/HOME_SETUP.md)**.

---

## Run it on your computer (optional, good for learning)

You need Python 3.11 or newer.

```bash
# 1. Get the code
git clone https://github.com/kingsley3r/stock-analyzer.git
cd stock-analyzer

# 2. Create an isolated Python environment and install the libraries
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 3. Put your secrets in a .env file (it is ignored by git, so it never gets uploaded)
cp .env.example .env             # then open .env and fill in the values

# 4. Find your Telegram chat id (after sending your bot a message)
python -m analyzer.telegram_setup

# 5. Try it
python -m analyzer.digest --dry-run   # only collects data, free; look at output/data-*.json
python -m analyzer.digest --no-send   # writes the digest and prints it (costs a few cents)
python -m analyzer.digest             # the real thing: sends it to Telegram

# Run the tests
python -m pytest
```

---

## Changing things

- **Watchlist:** edit `config/watchlist.yaml`. Find the symbol on finance.yahoo.com
  (e.g. German stocks end in `.DE`, Amsterdam in `.AS`, Paris in `.PA`).
- **YouTube channels:** add a line in `config/sources.yaml` with the handle from the
  channel URL, e.g. `youtube.com/@CoinBureau` → `handle: CoinBureau`.
- **Time:** change the `cron` line in `.github/workflows/morning-digest.yml`.
  GitHub uses UTC time; Istanbul is UTC+3. GitHub may start a few minutes late.
- **What the briefing says:** edit `SYSTEM_PROMPT` in `analyzer/ai.py`.

## Known limits

- European stock prices from free sources can be 15 minutes delayed. That's fine for a morning
  briefing, but it matters for day trading later.
- YouTube sometimes blocks transcript downloads from cloud servers. Then the digest uses only
  titles and descriptions and says so.
- If a news feed stops working, it is skipped and a warning shows in the GitHub Actions log.
- If a run fails, the bot sends you a short "digest failed" message.
