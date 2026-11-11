#!/usr/bin/env bash
# Renders the link-preview card (web/og/card.html) to web/public/og.png at
# 1200x630, the size X, Telegram and Discord show as a large preview.
#
# Needs Google Chrome and `npm ci` in web/ for the fonts.
# Usage: web/og/render.sh
set -euo pipefail
cd "$(dirname "$0")"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
  --force-device-scale-factor=1 --window-size=1200,630 --virtual-time-budget=4000 \
  --screenshot="$PWD/../public/og.png" "file://$PWD/card.html" 2>/dev/null
echo "Wrote web/public/og.png"
