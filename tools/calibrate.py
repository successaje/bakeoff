#!/usr/bin/env python3
"""Sets a challenge's gates from the sponsor's own baseline.

Runs the baseline candidate over the sealed test set with the wasm
evaluator, on the sponsor's machine, several times, and derives the gates
from the median of each metric, since reasoning models vary by a few
points between runs even at temperature 0:

  accuracy   at least the baseline's, minus a tolerance
  cost       at most the baseline's, minus the required cut
  latency    p95 no worse than the baseline's
  leaks      none

Writes the rules with those gates, and a report of the baseline's
aggregate metrics. The report is safe to publish: it says nothing about
individual tickets.

Usage:
  calibrate.py --rules RULES --baseline CANDIDATE --test-set SEALED \\
               --out RULES_OUT --report REPORT_OUT [--cost-cut 0.25] \\
               [--accuracy-tolerance-bp 200] [--concurrency 32] [--runs 3]

Needs wasmtime, a built evaluator (cargo build -p bakeoff-evaluator
--target wasm32-wasip2 --release) and BAKEOFF_LLM_API_KEY in the
environment.
"""

import argparse
import copy
import hashlib
import json
import os
import statistics
import subprocess
import sys

WASM = "target/wasm32-wasip2/release/bakeoff-evaluator.wasm"


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def canonical(text):
    """The form a test set is stored and hashed in: no trailing newlines."""
    return text.rstrip("\n")


def score(rules_json, config_json, test_set):
    request = json.dumps({"mode": "sealed", "rules_json": rules_json, "config_json": config_json})
    env = dict(os.environ, BAKEOFF_TEST_SET=test_set)
    run = subprocess.run(
        ["wasmtime", "run", "-S", "http", "--env", "BAKEOFF_LLM_API_KEY", "--env", "BAKEOFF_TEST_SET", WASM],
        input=request.encode(),
        capture_output=True,
        env=env,
        check=True,
    )
    errors = run.stderr.decode().strip().splitlines()
    return json.loads(run.stdout), errors


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rules", required=True, help="rules whose gates will be replaced")
    parser.add_argument("--baseline", required=True, help="the sponsor's current configuration")
    parser.add_argument("--test-set", required=True, help="the sealed ticket set")
    parser.add_argument("--out", required=True, help="where to write the calibrated rules")
    parser.add_argument("--report", required=True, help="where to write the baseline report")
    parser.add_argument("--cost-cut", type=float, default=0.25, help="required cost reduction (0.25 = 25%%)")
    parser.add_argument("--accuracy-tolerance-bp", type=int, default=200, help="accuracy a candidate may lose, in basis points")
    parser.add_argument("--concurrency", type=int, default=32, help="calls in flight while measuring the baseline")
    parser.add_argument("--runs", type=int, default=3, help="baseline runs; each gate comes from the median run")
    args = parser.parse_args()

    if not os.environ.get("BAKEOFF_LLM_API_KEY"):
        sys.exit("BAKEOFF_LLM_API_KEY must be set")
    rules = json.loads(read(args.rules))
    test_set = canonical(read(args.test_set))
    config_json = read(args.baseline)

    # Score the baseline with gates that cannot fail, so the verdict is
    # about the measurements alone.
    probe = copy.deepcopy(rules)
    probe["gates"] = {"min_accuracy_bp": 0, "max_cost_per_ticket_uusd": 10**12, "max_p95_latency_ms": 10**9, "max_leaks": 10**6}
    # A wider window and the full budget let a slow baseline finish; per-call
    # latency, which the gate is about, does not depend on either.
    probe["max_concurrency"] = max(rules.get("max_concurrency", 8), args.concurrency)
    probe["time_budget_ms"] = 100_000
    runs = []
    for run in range(1, args.runs + 1):
        verdict, errors = score(json.dumps(probe), config_json, test_set)
        metrics = verdict.get("metrics")
        if not metrics or verdict["reasons"]:
            sys.exit(f"baseline run {run} did not complete: {verdict['reasons']} {errors[:3]}")
        if metrics["upstream_errors"]:
            sys.exit(f"baseline run {run} had {metrics['upstream_errors']} failed model calls; rerun before calibrating")
        # Invalid answers are the baseline's own behaviour and count against
        # its accuracy, unlike failed calls, which say nothing about it.
        print(f"run {run}:    accuracy {metrics['accuracy_bp'] / 100:.1f}%, "
              f"{metrics['cost_per_ticket_uusd']} µ$ per ticket, p95 {metrics['p95_latency_ms']} ms, "
              f"{metrics['invalid_answers']} invalid answers")
        runs.append(metrics)

    # The median of each metric, taken separately; with an odd number of
    # runs every value is one that was actually measured.
    metrics = {key: statistics.median_low(r[key] for r in runs)
               for key in ("accuracy_bp", "cost_per_ticket_uusd", "p95_latency_ms")}

    gates = {
        "min_accuracy_bp": max(0, (metrics["accuracy_bp"] - args.accuracy_tolerance_bp) // 100 * 100),
        "max_cost_per_ticket_uusd": int(metrics["cost_per_ticket_uusd"] * (1 - args.cost_cut)),
        "max_p95_latency_ms": metrics["p95_latency_ms"],
        "max_leaks": 0,
    }
    rules["gates"] = gates
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(rules, f, indent=2)
        f.write("\n")

    report = {
        "baseline_config_sha256": hashlib.sha256(config_json.encode()).hexdigest(),
        "test_set_sha256": hashlib.sha256(test_set.encode()).hexdigest(),
        "baseline_metrics": metrics,
        "baseline_runs": runs,
        "policy": {"cost_cut": args.cost_cut, "accuracy_tolerance_bp": args.accuracy_tolerance_bp},
        "gates": gates,
    }
    with open(args.report, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
        f.write("\n")

    print(f"median:   accuracy {metrics['accuracy_bp'] / 100:.1f}%, "
          f"{metrics['cost_per_ticket_uusd']} µ$ per ticket, p95 {metrics['p95_latency_ms']} ms "
          f"over {len(runs)} runs")
    print(f"gates:    accuracy ≥ {gates['min_accuracy_bp'] / 100:.1f}%, "
          f"cost ≤ {gates['max_cost_per_ticket_uusd']} µ$ per ticket, "
          f"p95 ≤ {gates['max_p95_latency_ms']} ms, no leaks")


if __name__ == "__main__":
    main()
