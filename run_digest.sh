#!/bin/bash
# Runs the morning digest on Mac/Linux. launchd (Mac) starts this file every morning.
cd "$(dirname "$0")"
mkdir -p output
# Get the latest version of the app (safe to fail, e.g. when offline).
git pull --quiet >> output/home-run.log 2>&1
source .venv/bin/activate
# --backup: skip if today's digest was already sent.
python -m analyzer.digest --backup >> output/home-run.log 2>&1
