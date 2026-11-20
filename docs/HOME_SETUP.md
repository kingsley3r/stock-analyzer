# Run the digest on your home computer (with YouTube transcripts)

**Why:** YouTube blocks cloud servers like GitHub from reading video transcripts, but it
allows normal home internet. When your computer builds the digest, Claude can read what
the YouTubers actually *say*, not just the video titles.

**How the two runs work together:**

| Time (Istanbul) | Who | What happens |
|---|---|---|
| 05:45 | Your computer | Builds the digest with transcripts, sends it, and **pins** it in the Telegram chat. |
| ~06:30 | GitHub (backup) | Checks the pinned message. If today's digest is already there, it does nothing. If your computer was off, it sends the digest without transcripts. |

So you always get exactly one digest per day.

---

## Windows

### 1. Install the tools (one time)
1. **Python:** download from <https://www.python.org/downloads/> and run the installer.
   ✅ Tick **"Add python.exe to PATH"** on the first screen.
2. **Git:** download from <https://git-scm.com/download/win> and install with the default options.

### 2. Get the app
Open **Command Prompt** (press Windows key, type `cmd`, press Enter) and run these lines one by one:

```bat
cd %USERPROFILE%
git clone https://github.com/kingsley3r/stock-analyzer.git
cd stock-analyzer
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
notepad .env
```

Notepad opens. Fill in the same three values you put in the GitHub secrets
(`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), then save and close.
Leave `ANTHROPIC_WORKSPACE_ID=` empty.

Test it (this sends a digest to Telegram, costs about $0.20):
```bat
python -m analyzer.digest
```
In the log you should see lines like `Collected ... 8 videos (6 with transcript)`.

### 3. Schedule it for every morning
1. Press the Windows key, type **Task Scheduler**, open it.
2. On the right, click **Create Task...** (not "Basic Task").
3. **General** tab: Name `Stock Digest`. Select **"Run whether user is logged on or not"**.
4. **Triggers** tab → **New...** → **Daily**, start time **05:45:00** → OK.
5. **Actions** tab → **New...** → Program/script: click **Browse** and pick
   `run_digest.bat` in your `stock-analyzer` folder (usually `C:\Users\<you>\stock-analyzer`).
   In **"Start in"** paste that same folder path → OK.
6. **Conditions** tab: ✅ tick **"Wake the computer to run this task"**.
   Untick "Start the task only if the computer is on AC power" if you use a laptop.
7. **Settings** tab: ✅ tick **"Run task as soon as possible after a scheduled start is missed"**.
8. Click **OK** and enter your Windows password when asked.

To test the schedule: right-click **Stock Digest** → **Run**. Since today's digest is already
pinned, it should skip. The log is in `stock-analyzer\output\home-run.log`.

**Important:** the computer can be asleep (it wakes up), but not fully shut down.
In *Settings → System → Power*, sleep is fine; avoid "Shut down" at night.
Windows may also need *wake timers* allowed: Control Panel → Power Options → Change plan
settings → Change advanced power settings → Sleep → **Allow wake timers: Enable**.

---

## Mac

### 1. Install the tools (one time)
1. **Python:** download from <https://www.python.org/downloads/> and install.
2. **Git:** open **Terminal** (Cmd+Space, type Terminal) and run `git --version`.
   If it isn't installed, macOS offers to install it. Click **Install**.

### 2. Get the app
In Terminal:

```bash
cd ~
git clone https://github.com/kingsley3r/stock-analyzer.git
cd stock-analyzer
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
open -e .env
```

TextEdit opens. Fill in the same three values as the GitHub secrets, save and close.

Test it (sends a digest, costs about $0.20):
```bash
python -m analyzer.digest
```

### 3. Schedule it for every morning
```bash
sed "s#REPLACE_WITH_FOLDER#$HOME/stock-analyzer#" docs/com.stockanalyzer.digest.plist > ~/Library/LaunchAgents/com.stockanalyzer.digest.plist
launchctl load ~/Library/LaunchAgents/com.stockanalyzer.digest.plist
# Wake the Mac at 05:40 every day so the job can run:
sudo pmset repeat wakeorpoweron MTWRFSU 05:40:00
```
The last line asks for your Mac password.

The Mac can be asleep (it wakes at 05:40) but should not be shut down. If the job was missed,
macOS runs it as soon as the Mac wakes up. The log is in `stock-analyzer/output/home-run.log`.

---

## Updates

Each morning the script first runs `git pull`, so improvements made to the app on GitHub
reach your computer automatically. If you change `config/watchlist.yaml` on your computer,
also change it on GitHub (or ask Claude to), otherwise `git pull` may complain.
