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
  /**
   * SHA-256 of the baseline agent's config, as calibrate.py's report gives it. The owner's trial
   * runs of that config are the baseline as the enclave measured it.
   */
  baseline_config_sha256?: string;
  /** The workflow as it runs today, in the owner's words. */
  problem?: string;
  /** Public practice tickets builders can tune on. */
  practice_tickets?: number;
  /** Where the board serves the practice tickets, relative to the page. */
  practice_set?: string;
  /** Where the board serves the guide both ticket sets were labelled by. */
  labeling_guide?: string;
  /** Topics shown beside the challenge, as on a competition page. */
  tags?: string[];
  /** How the bounty was won, when there is something to tell. */
  story?: { headline: string; text: string };
  /**
   * A demonstration round: the sponsor is fictional and the Bakeoff team runs
   * the sponsor's account and the competing ones.
   */
  demo?: boolean;
  /** Listed on-chain by its owner, through the listing registry, rather than in challenges.json. */
  self_listed?: boolean;
  /** The account that listed it: the account the challenge was created under. */
  listed_by?: string;
}

/**
 * The listing registry (registry/) on each network, once deployed. Owners list their challenges
 * there without a pull request.
 */
export const LISTING_REGISTRY: Partial<Record<Network, string>> = {};

/**
 * Builds of the Bakeoff challenge contract, by NEAR code hash. A self-listed account is shown only
 * if it runs one of them, so a listing cannot pass off another contract as a challenge.
 */
export const CHALLENGE_CODE_HASHES = [
  "BRtk1Lbh4vHb92f97678AbwyXpS92XS6sKPDJqmbRrDF",
  "HeXPDJmQgPDfBfYvedbTL3iVyFvX7yZ84NH3s5n3tTGU",
];

interface RegistryListing {
  challenge: string;
  owner: string;
  listing: Omit<ListedChallenge, "id" | "problem" | "practice_set" | "labeling_guide" | "baseline_config_sha256"> & {
    problem: string | null;
    practice_set: string | null;
    labeling_guide: string | null;
    baseline_config_sha256: string | null;
  };
}

interface ListingReader {
  view<T>(accountId: string, method: string, args?: object): Promise<T>;
  codeHash(accountId: string): Promise<string>;
}

/** The challenges listed in a registry that run a Bakeoff challenge build, as board listings. */
export async function selfListedChallenges(registry: string, rpc: ListingReader): Promise<ListedChallenge[]> {
  const listed: RegistryListing[] = [];
  for (let from = 0; ; from += 100) {
    const page = await rpc.view<RegistryListing[]>(registry, "get_listings", { from_index: from, limit: 100 });
    listed.push(...page);
    if (page.length < 100) break;
  }
  const genuine = await Promise.all(listed.map(async (l) => (CHALLENGE_CODE_HASHES.includes(await rpc.codeHash(l.challenge).catch(() => "")) ? l : null)));
  return genuine.filter((l): l is RegistryListing => l !== null).map(({ challenge, owner, listing }) => ({
    id: challenge,
    title: listing.title,
    sponsor: listing.sponsor,
    summary: listing.summary,
    tickets: listing.tickets,
    baseline: listing.baseline,
    ...(listing.problem ? { problem: listing.problem } : {}),
    ...(listing.tags?.length ? { tags: listing.tags } : {}),
    ...(listing.baseline_config_sha256 ? { baseline_config_sha256: listing.baseline_config_sha256 } : {}),
    ...(listing.practice_set ? { practice_set: listing.practice_set } : {}),
    ...(listing.labeling_guide ? { labeling_guide: listing.labeling_guide } : {}),
    self_listed: true,
    listed_by: owner,
  }));
}

/** challenges.json first; a self-listed challenge is added unless the file already lists it. */
export function mergeListings(curated: ListedChallenge[], selfListed: ListedChallenge[]): ListedChallenge[] {
  const known = new Set(curated.map((c) => c.id));
  return [...curated, ...selfListed.filter((c) => !known.has(c.id))];
}

export type Registry = Record<Network, ListedChallenge[]>;

let loading: Promise<Registry> | null = null;

export function loadRegistry(): Promise<Registry> {
  loading ??= (async () => {
    const r = await fetch("./challenges.json");
    if (!r.ok) throw new Error(`could not load the challenge list (HTTP ${r.status})`);
    const curated = (await r.json()) as Registry;
    // Self-listed challenges join the curated ones; a registry that cannot be read leaves the board as it is.
    const { rpcFor } = await import("./data.ts");
    const networks = Object.entries(LISTING_REGISTRY) as [Network, string][];
    const added = await Promise.all(networks.map(([network, registry]) => selfListedChallenges(registry, rpcFor(network)).catch(() => [])));
    const merged = { ...curated };
    networks.forEach(([network], i) => { merged[network] = mergeListings(curated[network] ?? [], added[i]!); });
    return merged;
  })();
  return loading;
}

/** Testnet accounts end in .testnet; everything else is mainnet. */
export function networkOf(accountId: string): Network {
  return accountId.endsWith(".testnet") ? "testnet" : "mainnet";
}
