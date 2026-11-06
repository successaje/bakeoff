#!/usr/bin/env python3
"""Builds an evaluator request from rule, candidate and ticket files.

File contents are embedded byte for byte, because the evaluator hashes the
exact strings it receives and the contract compares those hashes.
"""

import argparse
import json
import sys


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mode", choices=["sealed", "dev"], default="sealed")
    parser.add_argument("--rules", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--test-set", help="ticket file, dev mode only")
    args = parser.parse_args()

    if args.mode == "sealed" and args.test_set:
        parser.error("sealed requests take the test set from the environment")
    request = {"mode": args.mode, "rules_json": read(args.rules), "config_json": read(args.config)}
    if args.test_set:
        request["test_set_json"] = read(args.test_set)
    json.dump(request, sys.stdout)


if __name__ == "__main__":
    main()
