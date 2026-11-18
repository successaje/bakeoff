#!/usr/bin/env bash
# Publishes the challenge contract once as a NEAR global contract (NEP-591), by its code hash, so
# new challenges reference it instead of storing their own 186 KB. Referenced by hash, the code a
# challenge runs can never change, even by whoever published it. Publishing an already published
# hash is skipped.
#
# It burns ten times the normal storage rate, once: about 18.6 NEAR for this contract (testnet
# NEAR on testnet). It publishes the build the board serves (web/public/contract), so challenges
# deployed either way run the same code.
#
# Needs near-cli-rs 0.20 or newer for deploy-as-global; set NEAR_CLI to use a specific binary.
# Environment overrides: CONTRACT_WASM.
set -euo pipefail
. "$(dirname "$0")/env.sh"

: "${BAKEOFF_ACCOUNT:?set BAKEOFF_ACCOUNT in .env}"
require_mainnet_confirmation "$BAKEOFF_ACCOUNT"
NEAR_CLI="${NEAR_CLI:-near}"
WASM="${CONTRACT_WASM:-web/public/contract/bakeoff_contract.wasm}"

HASH=$(scripts/code-hash.sh "$WASM")
bytes=$(wc -c < "$WASM" | tr -d ' ')
cost=$(python3 -I -c 'import sys; print(f"{int(sys.argv[1]) * 10 / 100_000:.2f}")' "$bytes")

echo "==> Publishing $WASM ($bytes bytes, code hash $HASH) as a global contract"
echo "    from $BAKEOFF_ACCOUNT on $NETWORK; this burns about $cost NEAR"
"$NEAR_CLI" contract deploy-as-global use-file "$WASM" as-global-hash "$BAKEOFF_ACCOUNT" \
  network-config "$NETWORK" sign-with-keychain send

echo
echo "Published. To have the board's setup form use it, set SHARED_CONTRACT.$NETWORK = \"$HASH\""
echo "in web/src/lib/deploy.ts."
