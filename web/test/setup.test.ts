import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { baselineFromReport, challengeId, commandsOf, type Draft, emptyDraft, gatesOf, issuesOf, listingOf, rulesOf } from "../src/lib/setup.ts";

const shipped = (name: string) => JSON.parse(readFileSync(new URL(`../../examples/rules/${name}`, import.meta.url), "utf8"));

/** The Kettle & Kiln round as a host would fill the form in. */
function kettleAndKiln(patch: Partial<Draft> = {}): Draft {
  return {
    ...emptyDraft("testnet", "kettle.testnet", new Date("2026-11-13T12:00:00Z")),
    title: "Support ticket triage",
    sponsor: "Kettle & Kiln",
    summary: "Route each message to the right team and urgency.",
    baseline: { accuracy: "87", cost: "128", p95: "18.159" },
    ...patch,
  };
}

test("the cheaper goal writes the rules the mainnet round was deployed with", () => {
  assert.deepEqual(rulesOf(kettleAndKiln()), shipped("near-ai.json"));
  assert.deepEqual(issuesOf(kettleAndKiln()), []);
});

test("the cheaper goal follows calibrate.py: accuracy within two points, rounded down to a whole point", () => {
  assert.deepEqual(gatesOf(kettleAndKiln({ baseline: { accuracy: "86.75", cost: "100", p95: "2.5" }, cut: "40" })), {
    min_accuracy_bp: 8400, max_cost_per_ticket_uusd: 60, max_p95_latency_ms: 2500, max_leaks: 0,
  });
});

test("faster and more accurate move one requirement and hold the others at the baseline", () => {
  assert.deepEqual(gatesOf(kettleAndKiln({ goal: "faster", fastP95: "3" })), { min_accuracy_bp: 8500, max_cost_per_ticket_uusd: 128, max_p95_latency_ms: 3000, max_leaks: 0 });
  assert.deepEqual(gatesOf(kettleAndKiln({ goal: "accurate", accuracyTarget: "92" })), { min_accuracy_bp: 9200, max_cost_per_ticket_uusd: 128, max_p95_latency_ms: 18159, max_leaks: 0 });
  assert.match(issuesOf(kettleAndKiln({ goal: "faster", fastP95: "20" }))[0]!.text, /faster than your baseline/);
  assert.match(issuesOf(kettleAndKiln({ goal: "accurate", accuracyTarget: "80" }))[0]!.text, /above your baseline/);
});

test("the owner's account must be valid and on the chosen network", () => {
  assert.match(issuesOf(kettleAndKiln({ account: "Kettle.testnet" }))[0]!.text, /not a valid NEAR account/);
  assert.match(issuesOf(kettleAndKiln({ network: "mainnet" }))[0]!.text, /ends in \.near/);
  assert.match(issuesOf(kettleAndKiln({ name: "c".repeat(60) }))[0]!.text, /64 characters/);
});

test("the evaluator's limits are checked before anything is deployed", () => {
  const texts = issuesOf(kettleAndKiln({ timeBudget: "120", concurrency: "40", temperature: "3", models: [] })).map((i) => i.text).join("\n");
  assert.match(texts, /at least one model/);
  assert.match(texts, /at most 100 seconds/);
  assert.match(texts, /from 1 to 32/);
  assert.match(texts, /between 0 and 2/);
});

test("the listing carries the baseline in the contract's units", () => {
  assert.deepEqual(listingOf(kettleAndKiln()), {
    id: "challenge-20261113.kettle.testnet",
    title: "Support ticket triage",
    sponsor: "Kettle & Kiln",
    summary: "Route each message to the right team and urgency.",
    tickets: 100,
    baseline: { accuracy_bp: 8700, cost_per_ticket_uusd: 128, p95_latency_ms: 18159 },
    tags: ["Classification", "Customer support", "Private test set"],
  });
});

test("mainnet commands name the signer twice, as the scripts require", () => {
  const draft = kettleAndKiln({ network: "mainnet", account: "kettle.near" });
  assert.equal(challengeId(draft), "challenge-20261113.kettle.near");
  const commands = commandsOf(draft);
  assert.match(commands, /NETWORK=mainnet MAINNET_CONFIRM=kettle\.near BAKEOFF_ACCOUNT=kettle\.near/);
  assert.match(commands, /NETWORK=mainnet MAINNET_CONFIRM=kettle\.near scripts\/near\/submit\.sh/);
  assert.doesNotMatch(commandsOf(kettleAndKiln()), /MAINNET_CONFIRM/);
});

test("calibration's report fills the baseline, and anything else is refused", () => {
  const report = JSON.stringify({ baseline_metrics: { accuracy_bp: 8700, cost_per_ticket_uusd: 128, p95_latency_ms: 18159 }, policy: {} });
  assert.deepEqual(baselineFromReport(report), { accuracy: "87", cost: "128", p95: "18.159" });
  assert.equal(baselineFromReport("{}"), null);
  assert.equal(baselineFromReport("not json"), null);
});
