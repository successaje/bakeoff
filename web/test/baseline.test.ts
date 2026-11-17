import assert from "node:assert/strict";
import { test } from "node:test";
import { enclaveBaseline } from "../src/lib/baseline.ts";
import type { EvaluationView } from "../src/lib/near.ts";
import type { ListedChallenge } from "../src/lib/registry.ts";

const CONFIG = "8bb2ccb0aa24288c6be335432488ea7dddd16b52a31c03e084ee8d9c0f86bf58";
const listing = { id: "c.near", title: "t", sponsor: "Kettle & Kiln", summary: "s", tickets: 100, baseline: { accuracy_bp: 8700, cost_per_ticket_uusd: 128, p95_latency_ms: 18159 }, baseline_config_sha256: CONFIG } satisfies ListedChallenge;

function run(id: number, submitter: string, config: string, metrics: Record<string, number> | null): EvaluationView {
  return { id, submitter, config_sha256: config, status: "Failed", reasons: [], eligible: false, requested_at: "1", settled_at: "2", verdict: metrics ? JSON.stringify({ metrics }) : null };
}
const m = (accuracy_bp: number, cost_per_ticket_uusd: number, p95_latency_ms: number) => ({ accuracy_bp, cost_per_ticket_uusd, p95_latency_ms, tickets: 100 });

test("the owner's trial of the baseline config is the baseline as the enclave measured it", () => {
  // The mainnet round: the owner ran baseline.json once, as result #0, before the winner's result #1.
  const evaluations = [run(0, "bakeoff.near", CONFIG, m(8500, 126, 11_514)), run(1, "agent.bakeoff.near", "aedee340", m(8900, 51, 2574))];
  assert.deepEqual(enclaveBaseline(listing, { owner: "bakeoff.near" }, evaluations), {
    runs: [{ id: 0, metrics: m(8500, 126, 11_514) }],
    metrics: { accuracy_bp: 8500, cost_per_ticket_uusd: 126, p95_latency_ms: 11_514 },
  });
});

test("only the owner's runs of that exact config count, and only ones the enclave scored", () => {
  const evaluations = [
    run(0, "bakeoff.near", "another-config", m(9900, 10, 100)),
    run(1, "someone.near", CONFIG, m(9900, 10, 100)),
    run(2, "bakeoff.near", CONFIG, null),
    run(3, "bakeoff.near", CONFIG, { tickets: 0 } as never),
  ];
  assert.equal(enclaveBaseline(listing, { owner: "bakeoff.near" }, evaluations), null);
});

test("several runs give each metric's median, the lower middle as calibrate.py takes it", () => {
  const evaluations = [run(4, "o.near", CONFIG, m(8800, 118, 25_300)), run(2, "o.near", CONFIG, m(8900, 122, 13_800)), run(7, "o.near", CONFIG, m(8500, 126, 11_500)), run(9, "o.near", CONFIG, m(8700, 130, 9000))];
  const measured = enclaveBaseline(listing, { owner: "o.near" }, evaluations)!;
  assert.deepEqual(measured.runs.map((r) => r.id), [2, 4, 7, 9]);
  assert.deepEqual(measured.metrics, { accuracy_bp: 8700, cost_per_ticket_uusd: 122, p95_latency_ms: 11_500 });
});

test("a listing that names no baseline config has no enclave baseline", () => {
  const { baseline_config_sha256: _, ...unnamed } = listing;
  assert.equal(enclaveBaseline(unnamed, { owner: "bakeoff.near" }, [run(0, "bakeoff.near", CONFIG, m(8500, 126, 11_514))]), null);
});
