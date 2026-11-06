#!/usr/bin/env python3
"""Calls a NEAR view method over JSON-RPC and prints the JSON result.

Usage: near_view.py <network> <account> <method> [json-args]
"""

import base64
import json
import sys
import urllib.request

RPC = {
    "testnet": "https://rpc.testnet.near.org",
    "mainnet": "https://rpc.mainnet.near.org",
}


def view(network, account, method, args):
    payload = {
        "jsonrpc": "2.0",
        "id": "bakeoff",
        "method": "query",
        "params": {
            "request_type": "call_function",
            "finality": "optimistic",
            "account_id": account,
            "method_name": method,
            "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
        },
    }
    request = urllib.request.Request(
        RPC[network], data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        reply = json.load(response)
    if "error" in reply:
        raise SystemExit(f"RPC error: {json.dumps(reply['error'])}")
    result = reply["result"]
    if "error" in result:
        raise SystemExit(f"view failed: {result['error']}")
    return json.loads(bytes(result["result"]) or b"null")


def main():
    if len(sys.argv) < 4:
        raise SystemExit(__doc__.strip())
    network, account, method = sys.argv[1:4]
    args = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
    json.dump(view(network, account, method, args), sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
