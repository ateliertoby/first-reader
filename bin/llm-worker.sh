#!/bin/bash
# MBA LLM worker wrapper — launched by launchd, invokes the node worker command.
# No .env needed: worker uses ssh alias `macmini` + local claude auth.
cd /Users/YOURUSER/Desktop/Project/outlook-cli || exit 1
exec /opt/homebrew/bin/node bin/email llm-worker
