/**
 * Chain reads for the pages, cached briefly so moving between pages is
 * instant. Every figure still comes from the contracts.
 */

import type { ChallengeRecords } from "./leaderboard.ts";
import { challengeGates, type ChallengeView, type EvaluationView, NearRpc, type Network, NETWORKS, verdictMetrics, type Metrics } from "./near.ts";
import { type ListedChallenge, loadRegistry, networkOf } from "./registry.ts";

const TTL = 15_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

const rpcs: Partial<Record<Network, NearRpc>> = {};
export function rpcFor(network: Network): NearRpc {
  return (rpcs[network] ??= new NearRpc(NETWORKS[network].rpc));
}

export interface ChallengeSummary {
  listing: ListedChallenge;
  network: Network;
  view: ChallengeView | null;
  error: string | null;
  /** The metrics of the awarded evaluation, when there is one. */
  winner: Metrics | null;
}

async function summarise(listing: ListedChallenge, network: Network): Promise<ChallengeSummary> {
  try {
    const rpc = rpcFor(network);
    const view = await rpc.getChallenge(listing.id);
    let winner: Metrics | null = null;
    if (view.award) {
      const evaluation = await rpc.view<EvaluationView | null>(listing.id, "get_evaluation", { id: view.award.evaluation });
      winner = evaluation ? verdictMetrics(evaluation) : null;
    }
    return { listing, network, view, error: null, winner };
  } catch (error) {
    return { listing, network, view: null, error: (error as Error).message, winner: null };
  }
}

export function loadChallenges(network: Network, fresh = false): Promise<ChallengeSummary[]> {
  return cached(`list:${network}`, async () => {
    const registry = await loadRegistry();
    return Promise.all((registry[network] ?? []).map((listing) => summarise(listing, network)));
  }, fresh);
}

export interface ChallengeDetail extends ChallengeSummary {
  view: ChallengeView;
  evaluations: EvaluationView[];
}

export function loadChallenge(id: string, fresh = false): Promise<ChallengeDetail> {
  return cached(`challenge:${id}`, async () => {
    const network = networkOf(id);
    const registry = await loadRegistry();
    const listing = registry[network]?.find((c) => c.id === id) ?? {
      id, title: id, sponsor: "Unlisted sponsor", summary: "This challenge is not in the board's list, so only its on-chain data is shown.", tickets: 0,
      baseline: { accuracy_bp: 0, cost_per_ticket_uusd: 0, p95_latency_ms: 0 },
    };
    const rpc = rpcFor(network);
    const view = await rpc.getChallenge(id);
    const evaluations = await rpc.getAllEvaluations(id, view.evaluations);
    const awarded = view.award ? evaluations.find((e) => e.id === view.award!.evaluation) : undefined;
    return { listing, network, view, error: null, evaluations, winner: awarded ? verdictMetrics(awarded) : null };
  }, fresh);
}

/** Every listed challenge on a network with all its results; one that cannot be read is left out. */
export function loadAll(network: Network, fresh = false): Promise<ChallengeDetail[]> {
  return cached(`all:${network}`, async () => {
    const registry = await loadRegistry();
    const settled = await Promise.allSettled((registry[network] ?? []).map((listing) => loadChallenge(listing.id, fresh)));
    return settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  }, fresh);
}

export function recordsOf(detail: ChallengeDetail): ChallengeRecords {
  const { listing, view, evaluations } = detail;
  return { id: listing.id, title: listing.title, sponsor: listing.sponsor, owner: view.owner, baseline: listing.baseline, gates: challengeGates(view), award: view.award, evaluations };
}

export function forget(id: string): void {
  cache.delete(`challenge:${id}`);
  cache.delete(`list:${networkOf(id)}`);
  cache.delete(`all:${networkOf(id)}`);
}

/** The most recent listed challenge whose reward has been paid, with its winning metrics. */
export function latestWin(rows: ChallengeSummary[]): ChallengeSummary | null {
  return rows.filter((r) => r.view?.award?.paid && r.winner).sort((a, b) => b.listing.id.localeCompare(a.listing.id))[0] ?? null;
}
