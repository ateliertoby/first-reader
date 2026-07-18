#!/bin/bash
# launchd wrapper: the daemon needs .env vars and launchd sources no shell profile
cd "$HOME/outlook-cli" || exit 1
source .env
export AZURE_CLIENT_ID TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID
exec /opt/homebrew/bin/node bin/email agent-loop
