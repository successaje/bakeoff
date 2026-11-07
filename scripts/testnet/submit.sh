#!/usr/bin/env bash
# Submits a candidate to the deployed challenge and waits for its verdict.
#
# Usage: scripts/testnet/submit.sh <candidate.json> [signer-account]
#
# The signer defaults to BAKEOFF_ACCOUNT, which may submit while the
# challenge is a draft.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
[ -f .deploy/testnet.env ] || { echo "run scripts/testnet/deploy.sh first" >&2; exit 1; }
. ./.deploy/testnet.env

CANDIDATE="${1:?usage: scripts/testnet/submit.sh <candidate.json> [signer-account]}"
SIGNER="${2:-${BAKEOFF_ACCOUNT:?set BAKEOFF_ACCOUNT in .env}}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-300}"

id=$(tools/near_view.py testnet "$CHALLENGE" get_challenge | python3 -c 'import json,sys; print(json.load(sys.stdin)["evaluations"])')
args=$(python3 -I -c 'import json,sys; print(json.dumps({"config_json": open(sys.argv[1], encoding="utf-8").read()}))' "$CANDIDATE")

echo "==> Submitting $CANDIDATE as evaluation $id"
started=$(date +%s)
# The transaction stays open until OutLayer resumes its yield, which can take
# longer than the RPC node waits, so an RPC timeout here is expected; the
# contract is polled for the outcome either way. Of the 0.035 NEAR, 0.01 pays
# for the evaluation record and OutLayer refunds what the run does not use.
# near-cli also refuses to send when the signer cannot cover the deposit plus
# the prepaid gas at the current price (about 0.34 NEAR in all); that and any
# other failure stops here instead of waiting for a verdict that cannot come.
if ! output=$(near contract call-function as-transaction "$CHALLENGE" submit json-args "$args" \
  prepaid-gas '300.0 Tgas' attached-deposit '0.035 NEAR' \
  sign-as "$SIGNER" network-config testnet sign-with-keychain send 2>&1); then
  if printf '%s' "$output" | grep -q "408 Request Timeout"; then
    echo "(RPC did not wait for the outcome; polling the contract)"
  else
    printf '%s\n' "$output" >&2
    echo "the submission was not sent" >&2
    exit 1
  fi
else
  printf '%s\n' "$output"
fi

echo "==> Waiting for the sealed evaluation"
while :; do
  evaluation=$(tools/near_view.py testnet "$CHALLENGE" get_evaluation "{\"id\": $id}")
  status=$(printf '%s' "$evaluation" | python3 -c 'import json,sys; e=json.load(sys.stdin); print(e["status"] if e else "Missing")')
  if [ "$status" = "Missing" ] && [ $(( $(date +%s) - started )) -gt 60 ]; then
    echo "evaluation $id was never recorded; the submission failed" >&2
    exit 1
  fi
  [ "$status" != "Pending" ] && [ "$status" != "Missing" ] && break
  if [ $(( $(date +%s) - started )) -gt "$TIMEOUT_SECONDS" ]; then
    echo "no verdict after ${TIMEOUT_SECONDS}s; check later with:" >&2
    echo "  tools/near_view.py testnet $CHALLENGE get_evaluation '{\"id\": $id}'" >&2
    exit 1
  fi
  sleep 5
done

python3 - "$evaluation" <<'EOF'
import json, sys
e = json.loads(sys.argv[1])
seconds = (int(e["settled_at"]) - int(e["requested_at"])) / 1e9
print("status:".ljust(22) + e["status"])
print("reasons:".ljust(22) + (", ".join(e["reasons"]) or "-"))
print("request to verdict:".ljust(22) + f"{seconds:.1f} s")
if e.get("verdict"):
    metrics = json.loads(e["verdict"]).get("metrics") or {}
    for key in ("tickets", "completed", "accuracy_bp", "cost_per_ticket_uusd",
                "p95_latency_ms", "leaks", "invalid_answers", "escalations", "elapsed_ms"):
        if key in metrics:
            print(f"{key}:".ljust(22) + str(metrics[key]))
EOF

# A pass that wins the bounty is paid a block or two after the verdict.
for _ in 1 2 3 4 5 6; do
  award=$(tools/near_view.py testnet "$CHALLENGE" get_challenge | python3 -c '
import json, sys
c, id = json.load(sys.stdin), int(sys.argv[1])
a = c.get("award")
if a and a["evaluation"] == id:
    state = "paid" if a["paid"] else ("in flight" if a["in_flight"] else "owed; anyone may call claim_award")
    amount, winner = int(a["amount"]) / 1e24, a["winner"]
    print("award:".ljust(22) + f"{amount:g} NEAR to {winner}, {state}")
' "$id")
  case "$award" in *"in flight"*) sleep 2 ;; *) break ;; esac
done
[ -n "$award" ] && echo "$award"
exit 0
