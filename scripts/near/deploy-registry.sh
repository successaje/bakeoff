#!/usr/bin/env bash
# Deploys the listing registry (registry/) to registry.<BAKEOFF_ACCOUNT> on
# NETWORK (testnet by default), so owners can list their challenges on the
# board themselves. The board reads it once the account is added to
# LISTING_REGISTRY in web/src/lib/registry.ts.
#
# Needs cargo-near 0.13+ (set CARGO_NEAR to use a specific binary).
# Environment overrides: REGISTRY_NAME (default registry), REGISTRY_BALANCE.
set -euo pipefail
. "$(dirname "$0")/env.sh"

: "${BAKEOFF_ACCOUNT:?set BAKEOFF_ACCOUNT in .env}"
require_mainnet_confirmation "$BAKEOFF_ACCOUNT"
CARGO_NEAR="${CARGO_NEAR:-cargo-near}"
REGISTRY="${REGISTRY_NAME:-registry}.$BAKEOFF_ACCOUNT"

echo "==> Building the registry"
"$CARGO_NEAR" near build non-reproducible-wasm --manifest-path registry/Cargo.toml --out-dir target/near
WASM=target/near/bakeoff_registry.wasm
# The code's storage at 0.00001 NEAR a byte, plus 0.2 NEAR to spare; listings pay for their own.
bytes=$(wc -c < "$WASM" | tr -d ' ')
REGISTRY_BALANCE="${REGISTRY_BALANCE:-$(python3 -I -c 'import sys; print(f"{int(sys.argv[1]) / 100_000 + 0.2:.2f} NEAR")' "$bytes")}"

echo "==> Creating $REGISTRY with $REGISTRY_BALANCE for its $bytes bytes of code"
near account create-account fund-myself "$REGISTRY" "$REGISTRY_BALANCE" \
  autogenerate-new-keypair save-to-keychain \
  sign-as "$BAKEOFF_ACCOUNT" network-config "$NETWORK" sign-with-keychain send

echo "==> Deploying and initialising"
near contract deploy "$REGISTRY" use-file "$WASM" \
  with-init-call new json-args '{}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-keychain send

echo
echo "Deployed $REGISTRY. To have the board read it, set LISTING_REGISTRY.$NETWORK = \"$REGISTRY\""
echo "in web/src/lib/registry.ts. Its key is in your keychain; deleting it locks the registry's code."
