import assert from "node:assert/strict";
import { test } from "node:test";
import { accuracyTick, chartAxes, inTargetArea, linear, niceAxis, niceStep, plotResults } from "../src/lib/chart.ts";
import type { EvaluationView, Gates } from "../src/lib/near.ts";

const gates: Gates = { min_accuracy_bp: 8500, max_cost_per_ticket_uusd: 96, max_p95_latency_ms: 18_159, max_leaks: 0 };

function result(id: number, submitter: string, status: EvaluationView["status"], metrics: Record<string, number> | null, reasons: string[] = []): EvaluationView {
  return {
    id, submitter, status, config_sha256: "", reasons, eligible: true,
    verdict: metrics ? JSON.stringify({ metrics }) : null,
    requested_at: "1", settled_at: status === "Pending" ? null : "2",
  };
}

test("plots settled results with figures, and counts the rest", () => {
  const plotted = plotResults([
    result(0, "owner.testnet", "Failed", { accuracy_bp: 8500, cost_per_ticket_uusd: 126, p95_latency_ms: 3000, leaks: 0 }, ["cost_over_limit"]),
    result(1, "a.testnet", "Passed", { accuracy_bp: 8900, cost_per_ticket_uusd: 51, p95_latency_ms: 2600, leaks: 0 }),
    result(2, "b.testnet", "Failed", { accuracy_bp: 9100, cost_per_ticket_uusd: 60, p95_latency_ms: 2000, leaks: 1 }, ["leaked_card_number"]),
    result(3, "c.testnet", "Pending", null),
    result(4, "d.testnet", "Rejected", { accuracy_bp: 9900, cost_per_ticket_uusd: 1, p95_latency_ms: 1, leaks: 0 }, ["test_set_mismatch"]),
    result(5, "e.testnet", "Failed", null, ["undeclared_tool"]),
    result(6, "f.testnet", "Passed", { accuracy_bp: 9300, cost_per_ticket_uusd: 72, p95_latency_ms: 2900, leaks: 0 }),
  ], "owner.testnet", 1);
  assert.deepEqual(plotted.points.map((p) => [p.id, p.outcome, p.trial]), [
    [0, "failed", true],
    [2, "failed", false],
    [6, "passed", false],
    [1, "winner", false],
  ]);
  assert.equal(plotted.scoring, 1);
  assert.equal(plotted.rejected, 1);
  assert.equal(plotted.unscored, 1);
  assert.deepEqual(plotted.points.find((p) => p.id === 2)?.reasons, ["leaked_card_number"]);
});

test("steps are 1, 2 or 5 times a power of ten", () => {
  assert.equal(niceStep(100, 5), 20);
  assert.equal(niceStep(70, 5), 20);
  assert.equal(niceStep(30, 5), 10);
  assert.equal(niceStep(1500, 4), 500);
  assert.equal(niceStep(0.3, 4), 0.1);
  assert.equal(niceStep(0, 4), 1);
});

test("an axis covers its values on round ticks, within its limits", () => {
  const cost = niceAxis([51, 60, 72, 96, 126], 5, 0);
  assert.ok(cost.domain[0] <= 51 && cost.domain[1] >= 126);
  assert.deepEqual(cost.ticks, [40, 60, 80, 100, 120, 140]);
  assert.ok(cost.ticks.every((t) => t >= cost.domain[0] && t <= cost.domain[1]));

  const accuracy = niceAxis([8500, 8900, 9300, 9900], 4, 0, 10_000);
  assert.equal(accuracy.domain[1], 10_000);
  assert.ok(accuracy.domain[0] <= 8500);
  assert.equal(accuracy.ticks.at(-1), 10_000);
});

test("an axis over a single value still has width", () => {
  const axis = niceAxis([72], 5, 0);
  assert.ok(axis.domain[1] > axis.domain[0]);
  assert.ok(axis.domain[0] <= 72 && axis.domain[1] >= 72);
  const empty = niceAxis([], 5, 0);
  assert.ok(empty.domain[1] > empty.domain[0]);
});

test("the axes include the requirements and the baseline, not just the results", () => {
  const { points } = plotResults([result(1, "a.testnet", "Passed", { accuracy_bp: 9300, cost_per_ticket_uusd: 72 })], "owner.testnet", null);
  const axes = chartAxes(points, gates, { accuracy_bp: 8800, cost_per_ticket_uusd: 128, p95_latency_ms: 18_000 });
  assert.ok(axes.cost.domain[1] >= 128);
  assert.ok(axes.accuracy.domain[0] <= 8500);
  const bare = chartAxes(points, null, { accuracy_bp: 0, cost_per_ticket_uusd: 0, p95_latency_ms: 0 });
  assert.ok(bare.cost.domain[1] < 128);
});

test("linear maps the domain onto the range, either way round", () => {
  const x = linear([0, 100], [40, 440]);
  assert.equal(x(0), 40);
  assert.equal(x(50), 240);
  const y = linear([8000, 10_000], [300, 20]);
  assert.equal(y(10_000), 20);
  assert.equal(y(9000), 160);
});

test("the target area is the accuracy and cost requirements", () => {
  assert.equal(inTargetArea({ cost: 96, accuracy: 8500 }, gates), true);
  assert.equal(inTargetArea({ cost: 97, accuracy: 9900 }, gates), false);
  assert.equal(inTargetArea({ cost: 10, accuracy: 8499 }, gates), false);
});

test("accuracy ticks read as percentages", () => {
  assert.equal(accuracyTick(8500, 500), "85%");
  assert.equal(accuracyTick(9050, 50), "90.5%");
});
