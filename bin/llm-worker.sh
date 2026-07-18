#!/bin/bash
# MBA LLM worker wrapper — launched by launchd, invokes the node worker command.
# No .env needed: worker uses ssh alias `macmini` + local claude auth.
# launchd PATH is bare — claude lives in ~/.local/bin, node deps expect homebrew
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
cd /Users/YOURUSER/outlook-cli || exit 1
exec /opt/homebrew/bin/node bin/email llm-worker
