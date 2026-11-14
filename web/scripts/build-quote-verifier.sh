#!/usr/bin/env bash
# Builds the TDX quote verifier (web/quote-verifier) to WebAssembly for the board.
#
# The output in web/src/vendor/quote-verifier is committed, so building the board needs no Rust.
# Rerun this after changing the crate. Needs Rust with the wasm32-unknown-unknown target and
# wasm-pack.
set -euo pipefail
cd "$(dirname "$0")/.."

out=src/vendor/quote-verifier
# wasm-bindgen's glue needs the reference-types build of its own runtime; without this flag
# recent Rust compiles that runtime out and the bindgen step fails with
# "failed to find the `__wbindgen_externref_table_dealloc` function".
export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+reference-types"
wasm-pack build quote-verifier --release --target web --out-dir "../$out" --out-name quote_verifier --no-pack
# wasm-pack writes a .gitignore that would keep the build out of the repository.
rm -f "$out/.gitignore"
python3 -I scripts/quote-verifier-notice.py
shasum -a 256 "$out/quote_verifier_bg.wasm"
