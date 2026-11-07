#!/usr/bin/env bash
# Escrows a bounty in the deployed challenge and opens it to everyone.
#
# Opening freezes the rules, evaluator and test set commitments. The first
# submission from someone other than the owner that passes every gate is
# paid the bounty; if none passes before the deadline, the owner gets it
# back with `withdraw_bounty`.
#
# Usage: [NETWORK=mainnet] scripts/near/open.sh <bounty-NEAR> <hours-open>
#   e.g. scripts/near/open.sh 1 72
set -euo pipefail
. "$(dirname "$0")/env.sh"
load_deployment

BOUNTY="${1:?usage: scripts/near/open.sh <bounty-NEAR> <hours-open>}"
HOURS="${2:?usage: scripts/near/open.sh <bounty-NEAR> <hours-open>}"
: "${BAKEOFF_ACCOUNT:?set BAKEOFF_ACCOUNT in .env}"
require_mainnet_confirmation "$BAKEOFF_ACCOUNT"

status=$(tools/near_view.py "$NETWORK" "$CHALLENGE" get_challenge | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
[ "$status" = "Draft" ] || { echo "$CHALLENGE is $status, not a draft" >&2; exit 1; }

closes_at=$(python3 -c 'import sys, time; print(time.time_ns() + int(float(sys.argv[1]) * 3600e9))' "$HOURS")

echo "==> Escrowing $BOUNTY NEAR"
near contract call-function as-transaction "$CHALLENGE" fund json-args '{}' \
  prepaid-gas '30.0 Tgas' attached-deposit "$BOUNTY NEAR" \
  sign-as "$BAKEOFF_ACCOUNT" network-config "$NETWORK" sign-with-keychain send

echo "==> Opening until $(python3 -c 'import sys, datetime; print(datetime.datetime.fromtimestamp(int(sys.argv[1]) / 1e9, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))' "$closes_at")"
near contract call-function as-transaction "$CHALLENGE" open json-args "{\"closes_at\": \"$closes_at\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$BAKEOFF_ACCOUNT" network-config "$NETWORK" sign-with-keychain send

tools/near_view.py "$NETWORK" "$CHALLENGE" get_challenge | python3 -c '
import json, sys
c = json.load(sys.stdin)
print("status:".ljust(22) + c["status"])
bounty = int(c["bounty"]) / 1e24
print("bounty:".ljust(22) + f"{bounty:g} NEAR")
print("closes_at:".ljust(22) + c["closes_at"])
'
