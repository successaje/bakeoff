#!/usr/bin/env bash
# Scores candidates with the wasm evaluator under wasmtime, the same way an
# OutLayer worker runs it: request on stdin, sealed test set and API key in
# the environment.
#
# With the default local rules the mock model API is started automatically.
# With rules that point at a real endpoint, BAKEOFF_LLM_API_KEY must be set
# (for example in .env).
#
# Usage: scripts/run-local.sh [--rules FILE] [--test-set FILE] [candidate.json ...]
set -euo pipefail
cd "$(dirname "$0")/.."

RULES=examples/rules/local.json
TEST_SET=data/tickets/sealed-sample.json
WASM=target/wasm32-wasip2/release/bakeoff-evaluator.wasm
MOCK_PORT=8787
candidates=()

while [ $# -gt 0 ]; do
  case "$1" in
    --rules) RULES="$2"; shift 2 ;;
    --test-set) TEST_SET="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) candidates+=("$1"); shift ;;
  esac
done

command -v wasmtime >/dev/null || { echo "wasmtime is required (brew install wasmtime)" >&2; exit 1; }
[ -f .env ] && set -a && . ./.env && set +a

endpoint=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["endpoint"])' "$RULES")
if [[ "$endpoint" == http://127.0.0.1:* ]]; then
  API_KEY=local-development-key
  python3 tools/mock_llm.py --port "$MOCK_PORT" 2>/dev/null &
  MOCK_PID=$!
  trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 50); do
    python3 -c "import socket; socket.create_connection(('127.0.0.1', $MOCK_PORT), 0.2)" 2>/dev/null && break
    sleep 0.1
  done
  [ ${#candidates[@]} -gt 0 ] || candidates=(examples/candidates/*.json)
else
  API_KEY="${BAKEOFF_LLM_API_KEY:?set BAKEOFF_LLM_API_KEY to score against $endpoint}"
  [ ${#candidates[@]} -gt 0 ] || candidates=(examples/candidates/near-ai/*.json)
fi

cargo build -q -p bakeoff-evaluator --target wasm32-wasip2 --release
mkdir -p target/verdicts

printf '%-22s %-7s %-24s %9s %12s %9s %6s %10s %9s\n' \
  candidate passed reasons accuracy cost/ticket p95 leaks escalated elapsed
for candidate in "${candidates[@]}"; do
  name=$(basename "$candidate" .json)
  verdict=$(python3 tools/make_request.py --rules "$RULES" --config "$candidate" \
    | wasmtime run -S http \
        --env BAKEOFF_LLM_API_KEY="$API_KEY" \
        --env BAKEOFF_TEST_SET="$(cat "$TEST_SET")" \
        "$WASM" 2>"target/verdicts/$name.log")
  printf '%s\n' "$verdict" > "target/verdicts/$name.json"
  python3 - "$name" "$verdict" <<'EOF'
import json, sys
name, v = sys.argv[1], json.loads(sys.argv[2])
m = v.get("metrics") or {}
reasons = ",".join(v["reasons"]) or "-"
acc = f'{m["accuracy_bp"] / 100:.1f}%' if m else "-"
cost = f'{m["cost_per_ticket_uusd"]} µ$' if m else "-"
p95 = f'{m["p95_latency_ms"]} ms' if m else "-"
elapsed = f'{m["elapsed_ms"] / 1000:.1f} s' if m else "-"
print(f'{name:22} {str(v["passed"]).lower():7} {reasons:24} {acc:>9} {cost:>12} {p95:>9} {m.get("leaks", "-"):>6} {m.get("escalations", "-"):>10} {elapsed:>9}')
EOF
done
echo
echo "Verdicts and transport logs: target/verdicts/"
