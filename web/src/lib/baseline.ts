/**
 * The baseline as the enclave measured it.
 *
 * A listing's baseline figures are the owner's own: calibrate.py runs their current agent three
 * times on their machine and takes the median of each metric. The same agent can also be scored
 * on-chain: while a challenge is a draft, its owner may submit trial runs, which the enclave scores
 * on the hidden test set like any result but which never win. When a listing names its baseline
 * config's hash (`baseline_config_sha256`, from calibrate.py's report), those trials are found by
 * that hash, so the board can show what the contract recorded beside what the owner published.
 */

import { type ChallengeView, type EvaluationView, type Metrics, verdictMetrics } from "./near.ts";
import type { ListedChallenge } from "./registry.ts";

export interface EnclaveBaseline {
  /** The owner's trial runs of the baseline config that the enclave scored, oldest first. */
  runs: { id: number; metrics: Metrics }[];
  /** Each metric's median over the runs, as calibrate.py takes it: with an even count, the lower middle. */
  metrics: Required<Pick<Metrics, "accuracy_bp" | "cost_per_ticket_uusd" | "p95_latency_ms">>;
}

function medianLow(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * The enclave's measurement of the listed baseline. Null when the listing names no baseline
 * config, or when the owner has not run it on this challenge; the listing's hash tells the two
 * apart.
 */
export function enclaveBaseline(listing: ListedChallenge, view: Pick<ChallengeView, "owner">, evaluations: EvaluationView[]): EnclaveBaseline | null {
  const config = listing.baseline_config_sha256;
  if (!config) return null;
  const runs = evaluations
    .filter((e) => e.submitter === view.owner && e.config_sha256 === config)
    .map((e) => ({ id: e.id, metrics: verdictMetrics(e) }))
    .filter((r): r is { id: number; metrics: Metrics } =>
      r.metrics !== null && (r.metrics.tickets ?? 0) > 0 && r.metrics.accuracy_bp !== undefined && r.metrics.cost_per_ticket_uusd !== undefined && r.metrics.p95_latency_ms !== undefined)
    .sort((a, b) => a.id - b.id);
  if (!runs.length) return null;
  return {
    runs,
    metrics: {
      accuracy_bp: medianLow(runs.map((r) => r.metrics.accuracy_bp!)),
      cost_per_ticket_uusd: medianLow(runs.map((r) => r.metrics.cost_per_ticket_uusd!)),
      p95_latency_ms: medianLow(runs.map((r) => r.metrics.p95_latency_ms!)),
    },
  };
}
