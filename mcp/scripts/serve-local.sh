#!/usr/bin/env bash
# Starts the built MCP server against the challenges in this repository's
# testnet config, for an MCP client such as Claude Code or Codex.
#
#   BAKEOFF_ACCOUNT      required: the account that signs submissions. Use a
#                        contributor account; the owner's submissions are trials.
#   BAKEOFF_LLM_API_KEY  NEAR AI Cloud key for practice runs. If unset, it is
#                        read from the repository's .env, and never printed.
#
# Example (from the repository root):
#   claude mcp add bakeoff -e BAKEOFF_ACCOUNT=you.testnet -- "$PWD/mcp/scripts/serve-local.sh"
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"

: "${BAKEOFF_ACCOUNT:?set BAKEOFF_ACCOUNT to the account that signs submissions}"
if [ -z "${BAKEOFF_LLM_API_KEY:-}" ] && [ -f "$repo/.env" ]; then
  BAKEOFF_LLM_API_KEY="$(sed -n 's/^BAKEOFF_LLM_API_KEY=//p' "$repo/.env" | tail -1)"
  export BAKEOFF_LLM_API_KEY
fi
[ -f "$repo/mcp/dist/index.js" ] || { echo "build the server first: (cd mcp && npm ci && npm run build)" >&2; exit 1; }

export BAKEOFF_MCP_CONFIG="${BAKEOFF_MCP_CONFIG:-$repo/mcp/bakeoff.testnet.json}"
export BAKEOFF_CACHE_DIR="${BAKEOFF_CACHE_DIR:-$repo/target/mcp-cache}"
exec node "$repo/mcp/dist/index.js"
