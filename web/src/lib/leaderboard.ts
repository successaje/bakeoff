/**
 * Leaderboards and activity, computed from the contracts' records alone.
 *
 * A challenge's leaderboard shows each builder once, by their best result:
 * the winner first, then other passes, then results still scoring, failures
 * by how many requirements they met, and rejections. The owner's trials are
 * listed last and never ranked, as the contract never pays them.
 */

import { type Award, type EvaluationView, type Gates, type Metrics, nsToDate, verdictMetrics } from "./near.ts";
import type { Baseline } from "./registry.ts";

export type Standing = "winner" | "passed" | "scoring" | "failed" | "rejected";

const ORDER: Record<Standing, number> = { winner: 0, passed: 1, scoring: 2, failed: 3, rejected: 4 };

export interface Entry {
  account: string;
  /** The builder's best result, the one the row shows. */
  best: EvaluationView;
  metrics: Metrics | null;
  standing: Standing;
  /** Requirements the best result met, out of four. */
  met: number;
  entries: number;
  /** When the builder's latest result was recorded, or submitted if still scoring. */
  last: Date | null;
  /** The owner's own trial runs. */
  trial: boolean;
  /** Null for trials, and for results with nothing to rank yet. */
  rank: number | null;
}

/** How many of the four requirements a result met. */
export function requirementsMet(gates: Gates | null, m: Metrics | null): number {
  if (!gates || !m) return 0;
  return [
    m.accuracy_bp !== undefined && m.accuracy_bp >= gates.min_accuracy_bp,
    m.cost_per_ticket_uusd !== undefined && m.cost_per_ticket_uusd <= gates.max_cost_per_ticket_uusd,
    m.p95_latency_ms !== undefined && m.p95_latency_ms <= gates.max_p95_latency_ms,
    m.leaks !== undefined && m.leaks <= gates.max_leaks,
  ].filter(Boolean).length;
}

export function standingOf(e: EvaluationView, awarded: number | null): Standing {
  if (e.id === awarded) return "winner";
  if (e.status === "Passed") return "passed";
  if (e.status === "Pending") return "scoring";
  return e.status === "Failed" ? "failed" : "rejected";
}

interface Scored { e: EvaluationView; metrics: Metrics | null; standing: Standing; met: number }

function better(a: Scored, b: Scored): number {
  return ORDER[a.standing] - ORDER[b.standing]
    || b.met - a.met
    || (b.metrics?.accuracy_bp ?? -1) - (a.metrics?.accuracy_bp ?? -1)
    || (a.metrics?.cost_per_ticket_uusd ?? Infinity) - (b.metrics?.cost_per_ticket_uusd ?? Infinity)
    || a.e.id - b.e.id;
}

const timeOf = (e: EvaluationView) => nsToDate(e.settled_at ?? e.requested_at);

export function rankBuilders(evaluations: EvaluationView[], gates: Gates | null, awarded: number | null): Entry[] {
  const byAccount = new Map<string, Scored[]>();
  for (const e of evaluations) {
    const metrics = verdictMetrics(e);
    const scored = { e, metrics, standing: standingOf(e, awarded), met: requirementsMet(gates, metrics) };
    byAccount.set(e.submitter, [...(byAccount.get(e.submitter) ?? []), scored]);
  }
  const entries = [...byAccount.entries()].map(([account, results]): Entry => {
    const best = [...results].sort(better)[0]!;
    const times = results.map((r) => timeOf(r.e)?.getTime() ?? 0);
    return {
      account,
      best: best.e,
      metrics: best.metrics,
      standing: best.standing,
      met: best.met,
      entries: results.length,
      last: Math.max(...times) > 0 ? new Date(Math.max(...times)) : null,
      trial: best.e.eligible === false,
      rank: null,
    };
  });
  entries.sort((a, b) => Number(a.trial) - Number(b.trial) || better(
    { e: a.best, metrics: a.metrics, standing: a.standing, met: a.met },
    { e: b.best, metrics: b.metrics, standing: b.standing, met: b.met },
  ));
  let rank = 0;
  for (const entry of entries) {
    if (!entry.trial && entry.standing !== "scoring" && entry.standing !== "rejected") entry.rank = ++rank;
  }
  return entries;
}

/** One challenge's records, as the board lists and the chain holds them. */
export interface ChallengeRecords {
  id: string;
  title: string;
  sponsor: string;
  owner: string;
  baseline: Baseline;
  gates: Gates | null;
  award: Award | null | undefined;
  evaluations: EvaluationView[];
}

/** Share of the baseline's cost saved, as a whole percentage. */
export function costCut(baselineCost: number, cost: number | undefined): number | null {
  if (!baselineCost || cost === undefined) return null;
  return Math.round((1 - cost / baselineCost) * 100);
}

export interface BuilderRecord {
  account: string;
  wins: number;
  /** Rewards the contracts have paid this account, in yoctoNEAR. */
  earned: bigint;
  passes: number;
  results: number;
  challenges: number;
  /** The largest cost cut among the account's passing results. */
  bestCut: number | null;
  last: Date | null;
  rank: number;
}

/** Every builder across the given challenges, ranked by rewards won. Owners' trials don't count. */
export function rankAccounts(challenges: ChallengeRecords[]): BuilderRecord[] {
  const records = new Map<string, Omit<BuilderRecord, "challenges" | "rank"> & { ids: Set<string> }>();
  for (const c of challenges) {
    for (const e of c.evaluations) {
      if (e.eligible === false || e.submitter === c.owner) continue;
      const r = records.get(e.submitter) ?? { account: e.submitter, wins: 0, earned: 0n, passes: 0, results: 0, bestCut: null, last: null, ids: new Set<string>() };
      r.results += 1;
      r.ids.add(c.id);
      if (e.status === "Passed") {
        r.passes += 1;
        const cut = costCut(c.baseline.cost_per_ticket_uusd, verdictMetrics(e)?.cost_per_ticket_uusd);
        if (cut !== null && (r.bestCut === null || cut > r.bestCut)) r.bestCut = cut;
      }
      if (c.award?.evaluation === e.id) {
        r.wins += 1;
        if (c.award.paid) r.earned += BigInt(c.award.amount);
      }
      const at = timeOf(e);
      if (at && (!r.last || at > r.last)) r.last = at;
      records.set(e.submitter, r);
    }
  }
  return [...records.values()]
    .map(({ ids, ...r }) => ({ ...r, challenges: ids.size, rank: 0 }))
    .sort((a, b) => b.wins - a.wins || (b.earned > a.earned ? 1 : b.earned < a.earned ? -1 : 0) || b.passes - a.passes || b.results - a.results || a.account.localeCompare(b.account))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

export type ActivityKind = "paid" | "passed" | "failed" | "scoring";

export interface Activity {
  kind: ActivityKind;
  at: Date;
  account: string;
  challenge: string;
  title: string;
  evaluation: number;
  /** The reward paid, in yoctoNEAR, for a payment. */
  amount?: string;
  /** A result from the owner's own trial run. */
  trial: boolean;
}

/** The latest things that happened across the given challenges, newest first. */
export function recentActivity(challenges: ChallengeRecords[], limit = 6): Activity[] {
  const events: Activity[] = [];
  for (const c of challenges) {
    for (const e of c.evaluations) {
      const base = { account: e.submitter, challenge: c.id, title: c.title, evaluation: e.id, trial: e.eligible === false };
      const settled = nsToDate(e.settled_at);
      if (e.status === "Pending") {
        const at = nsToDate(e.requested_at);
        if (at) events.push({ ...base, kind: "scoring", at });
      } else if (settled) {
        events.push({ ...base, kind: e.status === "Passed" ? "passed" : "failed", at: settled });
        // The contract pays in the callback that settles the winning result.
        if (c.award?.paid && c.award.evaluation === e.id) events.push({ ...base, kind: "paid", at: new Date(settled.getTime() + 1), amount: c.award.amount });
      }
    }
  }
  return events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
