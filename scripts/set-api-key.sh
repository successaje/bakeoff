#!/usr/bin/env bash
# Prompts for the NEAR AI Cloud API key without echoing it and stores it as
# BAKEOFF_LLM_API_KEY in .env (created from .env.example if missing).
# The key is never printed and never passed to another process.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

[ -f .env ] || cp .env.example .env

read -rsp "NEAR AI Cloud API key (input hidden): " key
echo
[ -n "$key" ] || { echo "No key entered; .env unchanged." >&2; exit 1; }

tmp=$(mktemp .env.XXXXXX)
grep -v '^BAKEOFF_LLM_API_KEY=' .env > "$tmp" || true
printf 'BAKEOFF_LLM_API_KEY=%s\n' "$key" >> "$tmp"
mv "$tmp" .env
chmod 600 .env
echo "Saved BAKEOFF_LLM_API_KEY to .env (${#key} characters)."
