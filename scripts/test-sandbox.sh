#!/usr/bin/env bash
# Builds the challenge contract and the mock OutLayer, then runs the sandbox
# end-to-end tests against a local NEAR node.
#
# Needs cargo-near 0.13+ (set CARGO_NEAR to use a specific binary). The first
# run downloads the NEAR sandbox binary.
set -euo pipefail
cd "$(dirname "$0")/.."

CARGO_NEAR="${CARGO_NEAR:-cargo-near}"
scripts/build-contract.sh
"$CARGO_NEAR" near build non-reproducible-wasm \
  --manifest-path tools/mock-outlayer/Cargo.toml \
  --out-dir target/near

cargo test -p bakeoff-integration-tests -- --ignored --test-threads 1 "$@"
