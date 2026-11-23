# Stock Analyzer

A personal AI market analyst. Every morning at about **06:00 Istanbul time** it:

1. downloads prices for your watchlist (US stocks, European stocks, crypto, major indices),
2. reads the last 24 hours of financial news (CNBC, MarketWatch, Yahoo Finance, FT headlines, CoinDesk and more),
3. checks new videos from finance and crypto YouTube channels, reading the transcripts when it can,
4. asks Claude to turn all of that into a short briefing with **signals and reasons**,
5. puts the briefing in the app's **🔔 inbox** and sends you an **iPhone notification**.

> ⚠️ The signals are analysis, not financial advice. They can be wrong. You make every decision.

This is **milestone 1** of the plan. Next come a web dashboard with charts, signals with a
track record, and a day-trading mode.

---

## How it works (the big picture)

```
config/*.yaml ──► prices.py   (Yahoo Finance)  ─┐
                  news.py     (RSS feeds)       ├─► digest.py ──► ai.py (Claude) ──► inbox.py ──► 🔔📱
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
| `analyzer/inbox.py` | Saves every message (encrypted) for the app's 🔔 inbox and sends iPhone notifications (Web Push). |
| `analyzer/digest.py` | The main program that runs all steps in order. |
| `.github/workflows/morning-digest.yml` | Tells GitHub to run the digest every morning for free. |

---

## Setup (one time, about 20 minutes)

You need two secret values. Keep them private: anyone with them can use your accounts.

### 1. A dashboard password

Make up a long password. It encrypts everything the app shows (`DASHBOARD_PASSWORD`).

### 2. Claude API key (pay per use)

1. Go to <https://console.anthropic.com>, sign up, and add a payment method under **Billing**.
   Set a monthly spend limit (e.g. $20) so there are no surprises.
2. Under **API Keys**, create a key. That is `ANTHROPIC_API_KEY` (starts with `sk-ant-`).

Expected cost: roughly $0.10 to $0.40 per digest with the default model, so about $3 to $12 a month.
To pay less, set `model: claude-haiku-5-5` in `config/settings.yaml`.

### 3. Add the secrets to GitHub

In your repository on github.com: **Settings → Secrets and variables → Actions → New repository secret**.
Add the secrets: `ANTHROPIC_API_KEY` and `DASHBOARD_PASSWORD` (and `FINNHUB_API_KEY` for live prices).

If a run fails with *"This API key is not scoped to a workspace"*, also add `ANTHROPIC_WORKSPACE_ID`:
in the Claude Console open **Settings → Workspaces**, open your workspace (e.g. "Default"),
and copy its id (starts with `wrkspc_`).

Then go to the **Actions** tab → **Morning digest** → **Run workflow** to test it right away.
After that it runs by itself every morning.

---

## Dashboard (web app for your iPhone)

**Address:** <https://kingsley3r.github.io/stock-analyzer/>

Five tabs: **Today** (signals, biggest moves, the morning briefing), **Watchlist** (every
symbol with a 30-day mini chart; tap one for a full chart with 50- and 200-day averages),
**News** (filter by your stocks, AI, crypto), **Videos** (new videos from your channels with publish time, views, likes and a 🔥 Trending badge) and **Record** (how earlier signals turned out).
The data updates every 15 minutes and right after each morning digest.

**Live prices (● LIVE):** while the page is open, crypto prices come live from Coinbase (free, no key)
and US stock prices come live from Finnhub during US trading hours (17:30 to 00:00 Istanbul time in winter, 16:30 to 23:00 in summer).
The open chart moves with them. European stocks stay about 15 minutes delayed.
For US live prices add a free Finnhub key: sign up at <https://finnhub.io>, copy the API key from
the dashboard, and add it as the repository secret `FINNHUB_API_KEY`.

**One-time setup:**
1. In the repository on github.com open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Add a repository secret named `DASHBOARD_PASSWORD` (Settings → Secrets and variables → Actions)
   with a password of your choice. Use a long one; it protects your data.
3. Open the **Actions** tab → **Dashboard** → **Run workflow**.

**Private by password:** all data on the website is encrypted (AES-256) with your password.
The page asks for it once, and your phone can remember it. Without the password, visitors see
only a lock screen. To change the password, update the secret and run the Dashboard workflow.

### Edit the watchlist in the app

Tap **Watchlist → ✏️ Edit list**, add or remove symbols, then **Save**. The app saves the
change to `config/watchlist.yaml` in this repository, and the dashboard rebuilds in about 2 minutes.
The next morning digest uses the new list too.

Saving needs a GitHub key that can only change this one repository. Create it once:
1. On github.com open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Name: `stock-analyzer app`. Expiration: 1 year (or what you like).
3. **Repository access:** *Only select repositories* → `stock-analyzer`.
4. **Permissions → Repository permissions → Contents:** *Read and write*. Leave everything else as is.
5. Click **Generate token**, copy it (starts with `github_pat_`), and paste it in the app's editor.

The key is stored only on your phone (in the browser), never in the repository.

To add something, type a company name or symbol in the search box ("netflix", "bmw", "xrp") and tap
the right result. The list comes from `site/symbols.js` (popular US, European, crypto and index
symbols) plus Finnhub's symbol search when `FINNHUB_API_KEY` is set.

**⭐ Favorites:** tap ☆ next to any stock (or on its page) to pin it to the top of the Watchlist
and to the Today page. Use **↕️ Reorder** to change the order. Favorites are saved on your phone.

**Logos:** company logos come from Financial Modeling Prep's free logo images, coin icons from the
open-source cryptocurrency-icons set, and news site icons from Google. If a logo is missing, a
colored circle with the first letters is shown.

**🔔 Inbox and iPhone notifications:** the bell at the top opens your inbox: every alert, the
morning digest and the evening recap of the last 30 days (a red number shows how many are new).
To get them as real notifications, open the app from its Home Screen icon (iOS 16.4 or newer),
go to **⚙️ Settings → 🔔 Turn on notifications** and allow them. About 3 minutes later a
"✅ Notifications are on" test arrives. This uses the free Web Push standard: no Telegram, no
extra account. Your phone's notification address is saved encrypted in `config/push/`; the
signing key is calculated from `DASHBOARD_PASSWORD` (if you change the password, turn
notifications on again). During your quiet time alerts wait silently in the inbox; only the
morning digest still notifies. Code: `analyzer/inbox.py` and `site/sw.js`.

**🚨 News alerts:** with every dashboard update (every 15 minutes) the app checks the
news. When a headline from the last hour names one of your watchlist stocks or coins *and* contains
a market-moving word (earnings, downgrade, lawsuit, merger, plunge, ...), you get an alert with
the link, today's price move, a 1-3 sentence summary and the likely effect on the price
(📈 up / 📉 down / ↔️ unclear), written by Claude from the headline and feed text. The summary costs about
$0.005 per alert (roughly $1-3 a month); turn it off with `ai_summary: false`. Set them up in the app under **⚙️ Settings**:
turn alerts on or off and choose a quiet time (e.g. 23:00 to 07:00). The app saves this to
`config/alerts.yaml`. Defaults: `news_alerts` in `config/settings.yaml`; the word list is in `analyzer/news_alerts.py`.

The **🕒 Markets** card on the Today tab shows when New York, Frankfurt, Vienna and London open
and close, in Istanbul time, with a countdown. Public holidays are not included.

**Updates:** when a new app version is published, the app notices it on the next data load and
reloads itself once.

### More tools

- **🧺 ETFs:** the watchlist has an ETFs section (starts with 4 UCITS ETFs on Xetra that flatex
  sells: VWCE, EUNL, SXR8, EQQQ). Add more in ✏️ Edit list (search knows the popular ones).
  ETF pages show the yearly fee, fund size and biggest holdings; Compare adds fee, size,
  3/5-year returns, top holdings and how much two ETFs overlap.
- **⚖️ Compare tab:** put 2 to 4 stocks, coins or indices side by side. One chart where every line
  starts at 0 % (fair even when prices are very different), a few plain sentences (who did best,
  who swings more, how much they move together), and a table: changes, risk, trend, company
  size in US dollars (market value, yearly sales, profit, free cash flow, employees, coin supply),
  price tag (P/E, P/S, cash flow yield, EPS), margins, growth, debt, 1-year range, money traded
  per day, dividend yield, AI signal and analyst view. 🏆 marks the
  better number per row. Open it from the tab or with **⚖️ Compare with others** on any stock page.
  Company numbers come from Yahoo Finance once a day (`analyzer/fundamentals.py`, cached in
  `record/fundamentals.json`).
- **💼 Portfolio tab → My portfolio:** add the trades you made (bought/sold, shares, price, date, fee).
  The app works out your holdings, average buy price, total value, today's change and profit/loss.
  Your trades are stored **only on your phone** (never online). Use **⬇️ Save backup file** now and then.
  Prices come from your watchlist; holdings that aren't on it are counted at what you paid.
- **💼 Portfolio tab → 🧪 Paper trading:** a fake-money account ($1,000 start, $100 per 🟢 BUY signal)
  that follows the app's signals, so you can judge them before risking real money. Rules and numbers:
  `paper_trading` in `config/settings.yaml`, code in `analyzer/paper.py`.
- **💼 Portfolio tab → 💰 Dividends:** expected dividends from your holdings for the next 12
  months: total and per month (bar chart), the next payments with their dates, yield per holding
  and an after-tax estimate (27.5 % Austrian KESt, `dividends: tax_pct` in `config/settings.yaml`).
  Uses the last 12 months of payments from Yahoo Finance (`analyzer/dividends.py`, fetched once a
  day). Only stocks on your watchlist have dividend data. Each stock page also shows its dividend.
- **🔔 Price alerts:** on a stock's page, add "goes above / below" targets; you get a notification when it
  happens. Under ⚙️ Settings you choose the big-move alert (default: stocks ±5 %, coins ±8 % in a day).
  Targets are saved encrypted with your dashboard password (`config/price_alerts.json`). Checked every
  15 minutes with Yahoo prices (up to 15 min delayed). Code: `analyzer/price_alerts.py`.
- **📅 Earnings:** the Watchlist shows companies reporting in the next 14 days, each stock page shows
  its next date, and you get a reminder at 18:00 the evening before. Code: `analyzer/earnings.py`.
- **🌙 Evening recap:** right after the US close (00:15 Istanbul, Monday to Friday) a short message in
  the inbox covers what moved and why, the paper account and upcoming earnings.
  It notifies you unless it arrives in your quiet time. Written by Claude, about $0.10 a day. Workflow: `.github/workflows/evening-recap.yml`.

**Install on iPhone:** open the address in Safari, tap **Share ⬆️ → Add to Home Screen**.
It then opens full-screen like a normal app.

> Note: the code and `config/watchlist.yaml` are visible in this public repository. The
> dashboard data (briefing, signals, news) is encrypted. Your API keys are never visible.

How it is built:

| File | What it does |
|---|---|
| `analyzer/dashboard_data.py` | Collects prices (2 years, for charts), news, videos and the inbox (`record/inbox/`). Writes `site/data/*.json`. |
| `site/index.html` | The page skeleton: top bar, content area, bottom tabs, and the lines that make it installable. |
| `site/styles.css` | All colors and layout. Light and dark mode follow your iPhone setting. |
| `site/app.js` | Unlocks and loads the data and draws each tab. Read the comments at the top first. |
| `analyzer/track_record.py` | Saves each day's signals and checks them later: a BUY is ✅ right if the price is higher 1 week later, a SELL / DON'T BUY if it's lower. Shown in the **Record** tab. The saved log lives (encrypted) on the `track-record` branch. |
| `analyzer/lock.py` | Encrypts the data with your password before it is published. |
| `site/vendor/` | The chart library (TradingView Lightweight Charts, free and open source). |
| `.github/workflows/dashboard.yml` | Rebuilds the data every 15 minutes and publishes the site. |

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

# 4. Try it
python -m analyzer.digest --dry-run   # only collects data, free; look at output/data-*.json
python -m analyzer.digest --no-send   # writes the digest and prints it (costs a few cents)
python -m analyzer.digest             # the real thing: saves it to record/inbox and notifies your phone

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
