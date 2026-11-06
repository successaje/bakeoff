#!/usr/bin/env bash
# Builds the challenge contract to target/near/bakeoff_contract.wasm.
#
# Needs cargo-near 0.13 or newer. Set CARGO_NEAR to use a binary other than
# the one on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

CARGO_NEAR="${CARGO_NEAR:-cargo-near}"
version=$("$CARGO_NEAR" near --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
minor=$(printf '%s' "$version" | cut -d. -f2)
if [ -z "$version" ] || [ "${minor:-0}" -lt 13 ]; then
  echo "cargo-near 0.13+ is required (found ${version:-none}): cargo install cargo-near --locked" >&2
  exit 1
fi

"$CARGO_NEAR" near build non-reproducible-wasm \
  --manifest-path contract/Cargo.toml \
  --out-dir target/near
