#!/usr/bin/env python3
"""Prints an account's access keys over JSON-RPC, one public key per line.

Usage: near_keys.py <network> <account>
"""

import json
import sys
import urllib.request

from near_view import RPC


def access_keys(network, account):
    payload = {
        "jsonrpc": "2.0",
        "id": "bakeoff",
        "method": "query",
        "params": {"request_type": "view_access_key_list", "finality": "final", "account_id": account},
    }
    request = urllib.request.Request(
        RPC[network], data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        reply = json.load(response)
    if "error" in reply:
        raise SystemExit(f"RPC error: {json.dumps(reply['error'])}")
    return [key["public_key"] for key in reply["result"]["keys"]]


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    for key in access_keys(sys.argv[1], sys.argv[2]):
        print(key)
