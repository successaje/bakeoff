#!/usr/bin/env bash
# Deploys a draft challenge to NEAR testnet, or mainnet with NETWORK=mainnet.
#
#   1. Builds the evaluator and publishes it to FastFS with the OutLayer CLI.
#   2. Builds the contract and deploys it to a new sub-account of
#      BAKEOFF_ACCOUNT, initialised with the rules, the evaluator's URL and
#      hash, and the test set's hash.
#   3. Writes the deployment to .deploy/<network>.env for the other scripts.
#
# Prerequisites (see README):
#   - BAKEOFF_ACCOUNT in .env, with its key in the system keychain (near-cli-rs)
#   - `outlayer login <network>` completed for the same account
#
# Environment overrides: RULES_FILE, TEST_SET_FILE, CHALLENGE_NAME, CHALLENGE_BALANCE
set -euo pipefail
. "$(dirname "$0")/env.sh"

: "${BAKEOFF_ACCOUNT:?set BAKEOFF_ACCOUNT in .env}"
require_mainnet_confirmation "$BAKEOFF_ACCOUNT"
RULES_FILE="${RULES_FILE:-examples/rules/near-ai.json}"
TEST_SET_FILE="${TEST_SET_FILE:-data/tickets/sealed-sample.json}"
CHALLENGE_NAME="${CHALLENGE_NAME:-challenge-$(date -u +%Y%m%d%H%M%S)}"
# The contract's 186 KB of code locks about 1.9 NEAR of storage.
CHALLENGE_BALANCE="${CHALLENGE_BALANCE:-2.5 NEAR}"
CHALLENGE="$CHALLENGE_NAME.$BAKEOFF_ACCOUNT"
SECRETS_PROFILE=bakeoff

for tool in near outlayer cargo python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

echo "==> Building evaluator"
cargo build -q -p bakeoff-evaluator --target wasm32-wasip2 --release
EVALUATOR_WASM=target/wasm32-wasip2/release/bakeoff-evaluator.wasm
EVALUATOR_SHA256=$(shasum -a 256 "$EVALUATOR_WASM" | cut -d' ' -f1)

echo "==> Publishing evaluator $EVALUATOR_SHA256 to FastFS"
upload_log=$(outlayer upload "$EVALUATOR_WASM" 2>&1 | tee /dev/stderr)
EVALUATOR_URL=$(printf '%s\n' "$upload_log" | grep -Eo 'https://[^ ]+\.wasm' | tail -1)
[ -n "$EVALUATOR_URL" ] || { echo "could not find the FastFS URL in the upload output" >&2; exit 1; }
case "$EVALUATOR_URL" in
  *"$EVALUATOR_SHA256"*) ;;
  *) echo "FastFS URL does not name the local build hash $EVALUATOR_SHA256" >&2; exit 1 ;;
esac

echo "==> Building contract"
scripts/build-contract.sh
CONTRACT_WASM=target/near/bakeoff_contract.wasm

# The canonical test set is the file without trailing newlines: environment
# variables commonly lose them, and the evaluator hashes what it receives.
TEST_SET_SHA256=$(python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], encoding="utf-8").read().rstrip("\n").encode()).hexdigest())' "$TEST_SET_FILE")
INIT_ARGS=$(python3 -I - "$RULES_FILE" "$OUTLAYER" "$EVALUATOR_URL" "$EVALUATOR_SHA256" \
  "$SECRETS_PROFILE" "$BAKEOFF_ACCOUNT" "$TEST_SET_SHA256" <<'EOF'
import json, sys
rules, outlayer, url, sha, profile, owner, test_set_sha = sys.argv[1:]
print(json.dumps({
    "owner": owner,
    "outlayer": outlayer,
    "evaluator": {"url": url, "sha256": sha},
    "secrets": {"profile": profile, "owner": owner},
    "rules_json": open(rules, encoding="utf-8").read(),
    "test_set_sha256": test_set_sha,
}))
EOF
)

echo "==> Creating $CHALLENGE"
near account create-account fund-myself "$CHALLENGE" "$CHALLENGE_BALANCE" \
  autogenerate-new-keypair save-to-keychain \
  sign-as "$BAKEOFF_ACCOUNT" network-config "$NETWORK" sign-with-keychain send

echo "==> Deploying contract"
near contract deploy "$CHALLENGE" use-file "$CONTRACT_WASM" \
  with-init-call new json-args "$INIT_ARGS" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-keychain send

mkdir -p .deploy
cat > "$DEPLOY_FILE" <<EOF
CHALLENGE=$CHALLENGE
OUTLAYER=$OUTLAYER
SECRETS_PROFILE=$SECRETS_PROFILE
EVALUATOR_URL=$EVALUATOR_URL
EVALUATOR_SHA256=$EVALUATOR_SHA256
RULES_FILE=$RULES_FILE
TEST_SET_FILE=$TEST_SET_FILE
TEST_SET_SHA256=$TEST_SET_SHA256
EOF

echo
echo "Deployed draft challenge $CHALLENGE on $NETWORK (details in $DEPLOY_FILE)."
echo "Next: run NETWORK=$NETWORK scripts/near/store-secrets.sh yourself, then trial runs with scripts/near/submit.sh."
