/**
 * Where each result lands by cost and accuracy, for a challenge's results
 * chart. Pure functions, so the layout is tested without a browser.
 */

import { type EvaluationView, type Gates, verdictMetrics } from "./near.ts";
import type { Baseline } from "./registry.ts";

export type Outcome = "winner" | "passed" | "failed";

export interface Point {
  id: number;
  submitter: string;
  /** Cost per ticket, in µ$. */
  cost: number;
  /** Accuracy, in basis points. */
  accuracy: number;
  p95: number | undefined;
  leaks: number | undefined;
  outcome: Outcome;
  /** One of the owner's trial runs: recorded, never paid. */
  trial: boolean;
  reasons: string[];
}

export interface Plotted {
  points: Point[];
  /** Results that are not drawn: still scoring, rejected, or settled with no figures. */
  scoring: number;
  rejected: number;
  unscored: number;
}

const LAYER: Record<Outcome, number> = { failed: 0, passed: 1, winner: 2 };

/**
 * The results that have figures to plot. A rejected result was not scored
 * against the challenge's commitments, so its figures are left out. Trials
 * are drawn first and the winner last, so the winner is never covered.
 */
export function plotResults(evaluations: EvaluationView[], owner: string, awarded: number | null): Plotted {
  const plotted: Plotted = { points: [], scoring: 0, rejected: 0, unscored: 0 };
  for (const e of evaluations) {
    if (e.status === "Pending") { plotted.scoring++; continue; }
    if (e.status === "Rejected") { plotted.rejected++; continue; }
    const m = verdictMetrics(e);
    if (m?.cost_per_ticket_uusd === undefined || m.accuracy_bp === undefined) { plotted.unscored++; continue; }
    plotted.points.push({
      id: e.id,
      submitter: e.submitter,
      cost: m.cost_per_ticket_uusd,
      accuracy: m.accuracy_bp,
      p95: m.p95_latency_ms,
      leaks: m.leaks,
      outcome: e.id === awarded ? "winner" : e.status === "Passed" ? "passed" : "failed",
      trial: e.submitter === owner,
      reasons: e.reasons,
    });
  }
  plotted.points.sort((a, b) => Number(b.trial) - Number(a.trial) || LAYER[a.outcome] - LAYER[b.outcome] || a.id - b.id);
  return plotted;
}

/** A round step near `span / count`: 1, 2 or 5 times a power of ten. */
export function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

export interface Axis {
  /** The ends of the axis, on round values. */
  domain: [number, number];
  ticks: number[];
  step: number;
}

/** An axis over `values` with some room either side, snapped out to round ticks and kept within [min, max]. */
export function niceAxis(values: number[], count: number, min = 0, max = Infinity): Axis {
  const finite = values.filter(Number.isFinite);
  let lo = finite.length ? Math.min(...finite) : min;
  let hi = finite.length ? Math.max(...finite) : min + 1;
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
  lo = Math.max(min, lo - pad);
  hi = Math.min(max, hi + pad);
  const step = niceStep(hi - lo, count);
  const domain: [number, number] = [Math.max(min, Math.floor(lo / step) * step), Math.min(max, Math.ceil(hi / step) * step)];
  if (domain[1] <= domain[0]) domain[1] = domain[0] + step;
  const ticks: number[] = [];
  for (let v = Math.ceil(domain[0] / step) * step; v <= domain[1] + step / 1e6; v += step) ticks.push(Number(v.toFixed(6)));
  return { domain, ticks, step };
}

export interface ChartAxes {
  cost: Axis;
  accuracy: Axis;
}

/**
 * Both axes, wide enough for every result, the requirements and the
 * baseline, so the frame stays put while a search narrows the points.
 */
export function chartAxes(points: Point[], gates: Gates | null, baseline: Baseline | null): ChartAxes {
  const costs = points.map((p) => p.cost);
  const accuracies = points.map((p) => p.accuracy);
  if (gates) {
    costs.push(gates.max_cost_per_ticket_uusd);
    accuracies.push(gates.min_accuracy_bp);
  }
  if (baseline?.cost_per_ticket_uusd && baseline.accuracy_bp) {
    costs.push(baseline.cost_per_ticket_uusd);
    accuracies.push(baseline.accuracy_bp);
  }
  return { cost: niceAxis(costs, 5, 0), accuracy: niceAxis(accuracies, 4, 0, 10_000) };
}

/** Maps a value on `domain` to a position on `range`. */
export function linear(domain: [number, number], range: [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  return (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
}

/** Whether a result meets the two requirements the chart can show: accuracy and cost. */
export function inTargetArea(point: Pick<Point, "cost" | "accuracy">, gates: Gates): boolean {
  return point.cost <= gates.max_cost_per_ticket_uusd && point.accuracy >= gates.min_accuracy_bp;
}

/** An accuracy tick, "85%"; with a decimal where the ticks are closer than a point apart. */
export function accuracyTick(bp: number, step: number): string {
  return `${(bp / 100).toFixed(step < 100 ? 1 : 0)}%`;
}
