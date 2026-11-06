#!/usr/bin/env bash
# Scores every example candidate with the wasm evaluator under wasmtime,
# against the local mock model API, exactly as an OutLayer worker would run
# it: request on stdin, sealed test set and API key in the environment.
#
# Usage: scripts/run-local.sh [candidate.json ...]
set -euo pipefail
cd "$(dirname "$0")/.."

RULES=examples/rules/local.json
TEST_SET=data/tickets/sealed-sample.json
WASM=target/wasm32-wasip2/release/bakeoff-evaluator.wasm
PORT=8787

command -v wasmtime >/dev/null || { echo "wasmtime is required (brew install wasmtime)" >&2; exit 1; }

cargo build -q -p bakeoff-evaluator --target wasm32-wasip2 --release

python3 tools/mock_llm.py --port "$PORT" 2>/dev/null &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT
for _ in $(seq 50); do
  python3 -c "import socket; socket.create_connection(('127.0.0.1', $PORT), 0.2)" 2>/dev/null && break
  sleep 0.1
done

candidates=("$@")
[ ${#candidates[@]} -gt 0 ] || candidates=(examples/candidates/*.json)

printf '%-22s %-7s %-24s %9s %12s %9s %6s %10s\n' candidate passed reasons accuracy cost/ticket p95 leaks escalated
for candidate in "${candidates[@]}"; do
  verdict=$(python3 tools/make_request.py --rules "$RULES" --config "$candidate" \
    | wasmtime run -S http \
        --env BAKEOFF_LLM_API_KEY=local-development-key \
        --env BAKEOFF_TEST_SET="$(cat "$TEST_SET")" \
        "$WASM")
  printf '%s' "$verdict" > "target/verdict-$(basename "$candidate")"
  python3 - "$candidate" "$verdict" <<'EOF'
import json, os, sys
name = os.path.basename(sys.argv[1]).removesuffix(".json")
v = json.loads(sys.argv[2])
m = v.get("metrics") or {}
reasons = ",".join(v["reasons"]) or "-"
acc = f'{m["accuracy_bp"] / 100:.1f}%' if m else "-"
cost = f'{m["cost_per_ticket_uusd"]} µ$' if m else "-"
p95 = f'{m["p95_latency_ms"]} ms' if m else "-"
print(f'{name:22} {str(v["passed"]).lower():7} {reasons:24} {acc:>9} {cost:>12} {p95:>9} {m.get("leaks", "-"):>6} {m.get("escalations", "-"):>10}')
EOF
done
echo
echo "Full verdicts: target/verdict-*.json"
