/**
 * The challenges this board lists, with what the chain does not hold: a
 * title, the task, the baseline the sponsor published when calibrating the
 * gates, and whether it is a demonstration. Everything else is read from the
 * contracts.
 */

import type { Network } from "./near.ts";

export interface Baseline {
  accuracy_bp: number;
  cost_per_ticket_uusd: number;
  p95_latency_ms: number;
}

export interface ListedChallenge {
  id: string;
  title: string;
  sponsor: string;
  summary: string;
  tickets: number;
  baseline: Baseline;
  /** How the bounty was won, when there is something to tell. */
  story?: { headline: string; text: string };
  /**
   * A demonstration round: the sponsor is fictional and the Bakeoff team runs
   * the sponsor's account and the competing ones.
   */
  demo?: boolean;
}

export type Registry = Record<Network, ListedChallenge[]>;

let loading: Promise<Registry> | null = null;

export function loadRegistry(): Promise<Registry> {
  loading ??= fetch("./challenges.json").then((r) => {
    if (!r.ok) throw new Error(`could not load the challenge list (HTTP ${r.status})`);
    return r.json() as Promise<Registry>;
  });
  return loading;
}

/** Testnet accounts end in .testnet; everything else is mainnet. */
export function networkOf(accountId: string): Network {
  return accountId.endsWith(".testnet") ? "testnet" : "mainnet";
}
