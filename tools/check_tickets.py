#!/usr/bin/env python3
"""Checks ticket sets before they are used in a challenge.

Validates the schema and labels against a rules file, prints the label
mix, lists tickets containing card numbers (same rule as the evaluator:
a 13-19 digit run, optionally grouped by single spaces or hyphens, that
passes the Luhn check), and reports tickets shared between sets, which
would leak sealed tickets into practice.

Usage: check_tickets.py --rules RULES SET [SET ...]
"""

import argparse
import collections
import json
import re
import sys

DIGIT_RUN = re.compile(r"\d(?:[ -]?\d)*")


def luhn_valid(digits):
    total = 0
    for i, d in enumerate(reversed(digits)):
        d = int(d)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def card_numbers(text):
    """Digit runs the evaluator would treat as card numbers."""
    found = []
    for match in DIGIT_RUN.finditer(text):
        run = match.group()
        if "  " in run or "--" in run:
            continue
        digits = re.sub(r"[ -]", "", run)
        if 13 <= len(digits) <= 19 and luhn_valid(digits):
            found.append(run)
    return found


def normalize(text):
    return re.sub(r"\W+", " ", text.lower()).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rules", required=True)
    parser.add_argument("sets", nargs="+")
    args = parser.parse_args()

    rules = json.load(open(args.rules, encoding="utf-8"))
    categories, priorities = set(rules["categories"]), set(rules["priorities"])
    problems = []
    seen_text = {}

    for path in args.sets:
        tickets = json.load(open(path, encoding="utf-8"))
        ids = collections.Counter(t["id"] for t in tickets)
        problems += [f"{path}: duplicate id {i}" for i, n in ids.items() if n > 1]
        for t in tickets:
            if set(t) != {"id", "text", "label"} or set(t["label"]) != {"category", "priority"}:
                problems.append(f"{path}: {t.get('id')} has unexpected fields")
                continue
            if t["label"]["category"] not in categories:
                problems.append(f"{path}: {t['id']} has unknown category {t['label']['category']}")
            if t["label"]["priority"] not in priorities:
                problems.append(f"{path}: {t['id']} has unknown priority {t['label']['priority']}")
            key = normalize(t["text"])
            if key in seen_text and seen_text[key][0] != path:
                problems.append(f"{t['id']} in {path} repeats {seen_text[key][1]} in {seen_text[key][0]}")
            seen_text.setdefault(key, (path, t["id"]))

        by_category = collections.Counter(t["label"]["category"] for t in tickets)
        by_priority = collections.Counter(t["label"]["priority"] for t in tickets)
        cards = [(t["id"], card_numbers(t["text"])) for t in tickets]
        cards = [(i, c) for i, c in cards if c]
        print(f"{path}: {len(tickets)} tickets")
        print("  categories: " + ", ".join(f"{c} {by_category[c]}" for c in rules["categories"]))
        print("  priorities: " + ", ".join(f"{p} {by_priority[p]}" for p in rules["priorities"]))
        print(f"  card numbers in {len(cards)} tickets: " + ", ".join(f"{i} ({c[0]})" for i, c in cards))

    if problems:
        print("\nProblems:")
        for p in problems:
            print("  " + p)
        sys.exit(1)
    print("\nNo problems found.")


if __name__ == "__main__":
    main()
