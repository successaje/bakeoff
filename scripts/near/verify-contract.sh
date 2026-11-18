#!/usr/bin/env bash
# Checks which source a deployed contract runs. It reads the account's code hash and the
# commit its `contract_source_metadata` names, rebuilds that commit reproducibly, and compares
# the two hashes. It works for any challenge, including one on a shared global contract, and for
# the listing registry. Nothing is signed or spent.
#
#   scripts/near/verify-contract.sh challenge-20261118120000.you.testnet
#
# A contract built before reproducible builds names no commit, and the script says so.
# Needs Docker, git and cargo-near 0.13+ (set CARGO_NEAR to use a specific binary).
# Environment overrides: RPC_URL.
set -euo pipefail
cd "$(dirname "$0")/../.."

ACCOUNT="${1:?usage: $0 <contract account>}"
case "$ACCOUNT" in
  *.near) RPC_URL="${RPC_URL:-https://rpc.mainnet.near.org}" ;;
  *.testnet) RPC_URL="${RPC_URL:-https://rpc.testnet.near.org}" ;;
  *) echo "$ACCOUNT is neither a .near nor a .testnet account" >&2; exit 2 ;;
esac
CARGO_NEAR="${CARGO_NEAR:-cargo-near}"

# The account's code hash (or the shared global contract it uses), and its source metadata.
READ_SOURCE=$(cat <<'EOF'
import base64, json, re, sys, urllib.request
rpc, account = sys.argv[1:]
def query(params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"finality": "final", **params}}).encode()
    request = urllib.request.Request(rpc, body, {"content-type": "application/json"})
    reply = json.load(urllib.request.urlopen(request, timeout=30))
    if "error" in reply or "error" in reply.get("result", {}):
        sys.exit(f"{account}: {reply.get('error') or reply['result']['error']}")
    return reply["result"]
view = query({"request_type": "view_account", "account_id": account})
code_hash = view.get("global_contract_hash") or view.get("code_hash")
if not code_hash or code_hash == "11111111111111111111111111111111":
    sys.exit(f"{account} has no contract")
args = base64.b64encode(b"{}").decode()
meta = json.loads(bytes(query({"request_type": "call_function", "account_id": account, "method_name": "contract_source_metadata", "args_base64": args})["result"]))
info = meta.get("build_info")
if not info:
    sys.exit(f"{account} runs code {code_hash}, built without a reproducible environment: its metadata names no commit to rebuild")
snapshot = re.fullmatch(r"git\+(https://\S+?)\?rev=([0-9a-f]{40})", info["source_code_snapshot"])
if not snapshot:
    sys.exit(f"unexpected source_code_snapshot: {info['source_code_snapshot']}")
print(code_hash, snapshot[1], snapshot[2], info.get("contract_path") or ".", info["build_environment"])
EOF
)
SOURCE=$(python3 -I -c "$READ_SOURCE" "$RPC_URL" "$ACCOUNT")
read -r ON_CHAIN REPO REV CONTRACT_PATH ENVIRONMENT <<< "$SOURCE"

echo "==> $ACCOUNT runs code $ON_CHAIN"
echo "    built from $REPO at $REV ($CONTRACT_PATH)"
echo "    in $ENVIRONMENT"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "==> Fetching $REV"
git init -q "$WORK/src"
git -C "$WORK/src" fetch -q --depth 1 "$REPO" "$REV"
git -C "$WORK/src" checkout -q FETCH_HEAD

echo "==> Rebuilding it reproducibly"
(cd "$WORK/src" && "$CARGO_NEAR" near build reproducible-wasm --manifest-path "$CONTRACT_PATH/Cargo.toml" --out-dir "$WORK/out")
REBUILT=$(scripts/code-hash.sh "$(ls "$WORK"/out/*.wasm | head -1)")

echo "==> Rebuilt code hash $REBUILT"
if [ "$REBUILT" = "$ON_CHAIN" ]; then
  echo "Match: $ACCOUNT runs exactly the code built from $REPO at $REV."
else
  echo "Mismatch: $ACCOUNT runs $ON_CHAIN, but that commit builds to $REBUILT." >&2
  exit 1
fi
