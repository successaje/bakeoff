import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChallengeRecords, rankAccounts, rankBuilders, recentActivity, requirementsMet } from "../src/lib/leaderboard.ts";
import type { EvaluationView, Gates } from "../src/lib/near.ts";
import { accountItems, challengeItems, search } from "../src/lib/search.ts";

const gates: Gates = { min_accuracy_bp: 8500, max_cost_per_ticket_uusd: 96, max_p95_latency_ms: 18_159, max_leaks: 0 };
const ns = (minutes: number) => String(BigInt(Date.UTC(2026, 10, 7) + minutes * 60_000) * 1_000_000n);

function result(id: number, submitter: string, status: EvaluationView["status"], metrics: Record<string, number> | null, extra: Partial<EvaluationView> = {}): EvaluationView {
  return {
    id, submitter, status, config_sha256: "", reasons: [], eligible: true,
    verdict: metrics ? JSON.stringify({ metrics }) : null,
    requested_at: ns(id * 10), settled_at: status === "Pending" ? null : ns(id * 10 + 1),
    ...extra,
  };
}

const pass = { accuracy_bp: 8900, cost_per_ticket_uusd: 51, p95_latency_ms: 2600, leaks: 0 };
const cheapButWrong = { accuracy_bp: 8200, cost_per_ticket_uusd: 48, p95_latency_ms: 2000, leaks: 0 };
const leaky = { accuracy_bp: 8800, cost_per_ticket_uusd: 95, p95_latency_ms: 7200, leaks: 1 };

test("requirements met count each of the four gates", () => {
  assert.equal(requirementsMet(gates, pass), 4);
  assert.equal(requirementsMet(gates, cheapButWrong), 3);
  assert.equal(requirementsMet(gates, leaky), 3);
  assert.equal(requirementsMet(gates, { accuracy_bp: 9000 }), 1);
  assert.equal(requirementsMet(null, pass), 0);
});

test("a challenge's leaderboard shows each builder once, winner first, trials unranked last", () => {
  const evaluations = [
    result(0, "owner.near", "Failed", { ...pass, cost_per_ticket_uusd: 126 }, { eligible: false }),
    result(1, "b.near", "Failed", cheapButWrong),
    result(2, "a.near", "Passed", pass),
    result(3, "b.near", "Failed", leaky),
    result(4, "c.near", "Passed", { ...pass, accuracy_bp: 9300 }),
    result(5, "d.near", "Pending", null),
    result(6, "e.near", "Rejected", null, { reasons: ["test_set_mismatch"] }),
  ];
  const board = rankBuilders(evaluations, gates, 2);
  assert.deepEqual(board.map((e) => [e.account, e.standing, e.rank]), [
    ["a.near", "winner", 1],
    ["c.near", "passed", 2],
    ["d.near", "scoring", null],
    ["b.near", "failed", 3],
    ["e.near", "rejected", null],
    ["owner.near", "failed", null],
  ]);
  const b = board.find((e) => e.account === "b.near")!;
  assert.equal(b.entries, 2);
  // Both of b's results met three requirements; the more accurate one is shown.
  assert.equal(b.best.id, 3);
  assert.equal(b.last?.getTime(), Date.UTC(2026, 10, 7) + 31 * 60_000);
  assert.equal(board.at(-1)!.trial, true);
});

const records = (over: Partial<ChallengeRecords>): ChallengeRecords => ({
  id: "c1.near", title: "Triage", sponsor: "Kettle & Kiln", owner: "owner.near",
  baseline: { accuracy_bp: 8700, cost_per_ticket_uusd: 128, p95_latency_ms: 18_159 },
  gates, award: null, evaluations: [], ...over,
});

test("builders are ranked across challenges by rewards won, and owners' trials never count", () => {
  const one = records({
    award: { evaluation: 2, winner: "a.near", amount: String(10n ** 24n), paid: true, in_flight: false },
    evaluations: [result(0, "owner.near", "Passed", pass, { eligible: false }), result(1, "b.near", "Passed", pass), result(2, "a.near", "Passed", { ...pass, cost_per_ticket_uusd: 32 })],
  });
  const two = records({ id: "c2.near", evaluations: [result(0, "b.near", "Failed", leaky), result(1, "b.near", "Passed", pass)] });
  const ranked = rankAccounts([one, two]);
  assert.deepEqual(ranked.map((r) => [r.rank, r.account, r.wins, r.passes, r.results, r.challenges]), [
    [1, "a.near", 1, 1, 1, 1],
    [2, "b.near", 0, 2, 3, 2],
  ]);
  assert.equal(ranked[0]!.earned, 10n ** 24n);
  assert.equal(ranked[0]!.bestCut, 75);
  assert.equal(ranked[1]!.bestCut, 60);
});

test("activity lists results and payments newest first", () => {
  const c = records({
    award: { evaluation: 1, winner: "a.near", amount: "5", paid: true, in_flight: false },
    evaluations: [result(0, "b.near", "Failed", leaky), result(1, "a.near", "Passed", pass), result(2, "c.near", "Pending", null)],
  });
  assert.deepEqual(recentActivity([c]).map((a) => [a.kind, a.account]), [
    ["scoring", "c.near"],
    ["paid", "a.near"],
    ["passed", "a.near"],
    ["failed", "b.near"],
  ]);
  assert.equal(recentActivity([c], 2).length, 2);
});

test("search finds challenges by title, host or account, and any full account name", () => {
  const registry = {
    mainnet: [{ id: "challenge-1.bakeoff.near", title: "Support ticket triage", sponsor: "Kettle & Kiln", summary: "", tickets: 100, baseline: { accuracy_bp: 0, cost_per_ticket_uusd: 0, p95_latency_ms: 0 } }],
    testnet: [],
  };
  const items = [...challengeItems(registry), ...accountItems(["agent.bakeoff.near", "agent.bakeoff.near"], "mainnet")];
  assert.equal(items.length, 2);
  assert.deepEqual(search(items, "triage").map((i) => i.to), ["/challenges/challenge-1.bakeoff.near"]);
  assert.deepEqual(search(items, "kiln support").map((i) => i.kind), ["challenge"]);
  assert.deepEqual(search(items, "agent").map((i) => i.to), ["/accounts/agent.bakeoff.near"]);
  assert.deepEqual(search(items, "someone.testnet").map((i) => [i.to, i.network]), [["/accounts/someone.testnet", "testnet"]]);
  assert.deepEqual(search(items, "   "), []);
});
