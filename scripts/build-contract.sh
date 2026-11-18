#!/usr/bin/env bash
# Builds a contract to target/near/: the challenge contract by default, or the listing registry
# with `scripts/build-contract.sh registry`.
#
# The build is reproducible (NEP-330). cargo-near builds the committed source inside the Docker
# image pinned in the crate's Cargo.toml, so the same commit always gives the same code hash, and
# the contract's `contract_source_metadata` view names that commit and image.
# `scripts/near/verify-contract.sh` uses this to check what a deployed challenge runs.
# It needs Docker and a working tree with no uncommitted changes.
#
# REPRODUCIBLE=0 builds the working tree with the local toolchain instead, as the tests do. That
# build's code hash depends on the toolchain, and its metadata names no commit.
#
# Needs cargo-near 0.13 or newer. Set CARGO_NEAR to use a binary other than the one on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

CRATE="${1:-contract}"
case "$CRATE" in
  contract | registry) ;;
  *) echo "usage: $0 [contract|registry]" >&2; exit 2 ;;
esac

CARGO_NEAR="${CARGO_NEAR:-cargo-near}"
version=$("$CARGO_NEAR" near --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
minor=$(printf '%s' "$version" | cut -d. -f2)
if [ -z "$version" ] || [ "${minor:-0}" -lt 13 ]; then
  echo "cargo-near 0.13+ is required (found ${version:-none}): cargo install cargo-near --locked" >&2
  exit 1
fi

if [ "${REPRODUCIBLE:-1}" = 0 ]; then
  "$CARGO_NEAR" near build non-reproducible-wasm --manifest-path "$CRATE/Cargo.toml" --out-dir target/near
else
  command -v docker >/dev/null || { echo "a reproducible build needs Docker; REPRODUCIBLE=0 builds without it" >&2; exit 1; }
  if [ -n "$(git status --porcelain)" ]; then
    echo "a reproducible build builds the committed source, and this tree has uncommitted changes:" >&2
    git status --short >&2
    echo "commit or stash them, or build a clean checkout (git worktree add)" >&2
    exit 1
  fi
  "$CARGO_NEAR" near build reproducible-wasm --manifest-path "$CRATE/Cargo.toml" --out-dir target/near
fi

wasm="target/near/bakeoff_$CRATE.wasm"
echo "$wasm: $(wc -c < "$wasm" | tr -d ' ') bytes, code hash $(scripts/code-hash.sh "$wasm")"
