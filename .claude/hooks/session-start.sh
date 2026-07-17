#!/bin/bash
set -euo pipefail
# Install dependencies for Claude Code on the web sessions.
# The repo root has no package.json; the only installable JS deps live
# in discord-bot/ (Cloudflare Worker), whose unit tests are the only
# verification runnable in a Linux container.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi
cd "$CLAUDE_PROJECT_DIR/discord-bot"
npm install --no-audit --no-fund
