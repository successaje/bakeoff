#!/usr/bin/env bash
# Stores the sealed test set and the model API key as OutLayer secrets for
# the deployed evaluator build.
#
# The secrets are bound to the evaluator's WASM hash, so no other binary can
# decrypt them, and admit only calls that come through the challenge
# contract, so nobody can run the evaluator on the sealed set directly.
#
# Run this yourself: it sends your API key to OutLayer's keystore. The
# OutLayer CLI encrypts it locally before it leaves this machine.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
[ -f .deploy/testnet.env ] || { echo "run scripts/testnet/deploy.sh first" >&2; exit 1; }
. ./.deploy/testnet.env

: "${BAKEOFF_LLM_API_KEY:?set BAKEOFF_LLM_API_KEY in .env}"
actual_sha=$(shasum -a 256 "$TEST_SET_FILE" | cut -d' ' -f1)
[ "$actual_sha" = "$TEST_SET_SHA256" ] || {
  echo "$TEST_SET_FILE changed since deployment ($actual_sha, contract expects $TEST_SET_SHA256)" >&2
  exit 1
}

# Built in Python so the test set is embedded byte for byte; its hash must
# match the contract's commitment.
secrets=$(python3 -I -c '
import json, os, sys
print(json.dumps({
    "BAKEOFF_TEST_SET": open(sys.argv[1], encoding="utf-8").read(),
    "BAKEOFF_LLM_API_KEY": os.environ["BAKEOFF_LLM_API_KEY"],
}))' "$TEST_SET_FILE")

outlayer secrets set "$secrets" \
  --wasm-hash "$EVALUATOR_SHA256" \
  --profile "$SECRETS_PROFILE" \
  --access allow-all \
  --via "$CHALLENGE"

echo
echo "Secrets stored for evaluator $EVALUATOR_SHA256, readable only through $CHALLENGE."
