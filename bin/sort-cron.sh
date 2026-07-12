#!/bin/bash
# Cron wrapper: truncate log + run sort
LOG="$HOME/outlook-cli/data/sort.log"
MAX_LINES=2000

# Truncate log if over limit
if [ -f "$LOG" ]; then
  lines=$(wc -l < "$LOG")
  if [ "$lines" -gt "$MAX_LINES" ]; then
    tail -1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
fi

cd "$HOME/outlook-cli"
source .env
export AZURE_CLIENT_ID
/opt/homebrew/bin/node bin/email sort
