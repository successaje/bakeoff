#!/usr/bin/env bash
# Deletes every access key of the deployed challenge account, so that nobody,
# its deployer included, can deploy other code to it or sign as it again.
#
# The contract keeps working: the owner's calls come from the owner's own
# account, and payouts and refunds are sent by the contract itself. Locking
# cannot be undone, and whatever the account holds beyond the bounty and its
# storage stays with the contract.
#
# open.sh runs this right after opening. Run it yourself to lock a challenge
# opened before that.
#
# Usage: [NETWORK=mainnet] scripts/near/lock.sh
set -euo pipefail
. "$(dirname "$0")/env.sh"
load_deployment

: "${BAKEOFF_ACCOUNT:?set BAKEOFF_ACCOUNT in .env}"
require_mainnet_confirmation "$BAKEOFF_ACCOUNT"

keys=$(tools/near_keys.py "$NETWORK" "$CHALLENGE")
if [ -z "$keys" ]; then
  echo "$CHALLENGE has no access keys: it is already locked."
  exit 0
fi

echo "==> Deleting the access keys of $CHALLENGE:"
printf '    %s\n' $keys
near account delete-keys "$CHALLENGE" public-keys "$(printf '%s' "$keys" | paste -sd, -)" \
  network-config "$NETWORK" sign-with-keychain send

remaining=$(tools/near_keys.py "$NETWORK" "$CHALLENGE")
[ -z "$remaining" ] || { echo "$CHALLENGE still has access keys: $remaining" >&2; exit 1; }
echo "Locked: $CHALLENGE has no access keys. Check it on $EXPLORER/address/$CHALLENGE"
