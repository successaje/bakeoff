#!/usr/bin/env bash
# Prints NEAR's code hash of a WebAssembly file: the base58 SHA-256 of its bytes, as
# `view_account` reports it and as a global contract (NEP-591) is referenced.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 file.wasm" >&2; exit 2; }
python3 -I - "$1" <<'EOF'
import hashlib, sys
digest = hashlib.sha256(open(sys.argv[1], "rb").read()).digest()
alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n, out = int.from_bytes(digest, "big"), ""
while n:
    n, r = divmod(n, 58)
    out = alphabet[r] + out
print("1" * (len(digest) - len(digest.lstrip(b"\0"))) + out)
EOF
