@echo off
rem Runs the morning digest on Windows. Task Scheduler starts this file every morning.
cd /d "%~dp0"
if not exist output mkdir output
rem Get the latest version of the app (safe to fail, e.g. when offline).
git pull --quiet >> output\home-run.log 2>&1
call .venv\Scripts\activate.bat
rem --backup: skip if today's digest was already sent.
python -m analyzer.digest --backup >> output\home-run.log 2>&1
