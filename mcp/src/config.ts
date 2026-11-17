import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type Network = "testnet" | "mainnet";

/** A challenge this server offers, with the public material contributors work from. */
export interface ChallengeConfig {
  id: string;
  /** Path or https URL of the public practice tickets. */
  practiceSet?: string;
  /** Path or https URL of the labeling guide the tickets were labelled with. */
  labelingGuide?: string;
}

export interface Config {
  network: Network;
  rpcUrl: string;
  /** The only challenges the tools will read, score against or submit to. */
  challenges: ChallengeConfig[];
  /** Account that signs submissions. Its key stays with near-cli. */
  account?: string;
  /** NEAR AI Cloud key for practice runs. Sealed runs use the sponsor's. */
  llmApiKey?: string;
  nearCli: string;
  signWith: "keychain" | "legacy-keychain";
  wasmtime: string;
  /** Sealed submissions one server process may send. */
  maxSubmissions: number;
  /** Where verified evaluator builds are kept, by SHA-256. */
  cacheDir: string;
  /** The Bakeoff board whose list of challenges is used when no config file is given. */
  boardUrl: string;
}

/** The public board: its /challenges.json lists every challenge with its practice set and labeling guide. */
export const BOARD_URL = "https://bakeoff-near.vercel.app";

/** FastNEAR's free endpoints, as the web app uses; near.org's rate-limit bursts. */
const RPC_URLS: Record<Network, string> = {
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

interface ConfigFile {
  network?: Network;
  rpc_url?: string;
  challenges?: { id: string; practice_set?: string; labeling_guide?: string }[];
}

/**
 * Reads the optional JSON file named by BAKEOFF_MCP_CONFIG, then applies
 * environment overrides. Relative paths in the file are relative to it.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let file: ConfigFile = {};
  let base = process.cwd();
  if (env.BAKEOFF_MCP_CONFIG) {
    const path = resolve(env.BAKEOFF_MCP_CONFIG);
    file = JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
    base = dirname(path);
  }
  const local = (p: string | undefined) =>
    p === undefined || /^https:\/\//.test(p) || isAbsolute(p) ? p : join(base, p);

  const network = (env.BAKEOFF_NETWORK ?? file.network ?? "testnet") as Network;
  if (!(network in RPC_URLS)) {
    throw new Error(`BAKEOFF_NETWORK must be testnet or mainnet, not ${network}`);
  }

  const challenges: ChallengeConfig[] = (file.challenges ?? []).map((c) => ({
    id: c.id,
    practiceSet: local(c.practice_set),
    labelingGuide: local(c.labeling_guide),
  }));
  for (const id of (env.BAKEOFF_CHALLENGES ?? "").split(",").map((s) => s.trim())) {
    if (id && !challenges.some((c) => c.id === id)) challenges.push({ id });
  }

  const signWith = env.BAKEOFF_SIGN_WITH ?? "keychain";
  if (signWith !== "keychain" && signWith !== "legacy-keychain") {
    throw new Error(`BAKEOFF_SIGN_WITH must be keychain or legacy-keychain, not ${signWith}`);
  }
  const maxSubmissions = Number(env.BAKEOFF_MAX_SUBMISSIONS ?? 3);
  if (!Number.isInteger(maxSubmissions) || maxSubmissions < 0) {
    throw new Error("BAKEOFF_MAX_SUBMISSIONS must be a whole number");
  }

  return {
    network,
    rpcUrl: env.BAKEOFF_RPC_URL ?? file.rpc_url ?? RPC_URLS[network],
    challenges,
    account: env.BAKEOFF_ACCOUNT || undefined,
    llmApiKey: env.BAKEOFF_LLM_API_KEY || undefined,
    nearCli: env.NEAR_CLI ?? "near",
    signWith,
    wasmtime: env.WASMTIME ?? "wasmtime",
    maxSubmissions,
    cacheDir: env.BAKEOFF_CACHE_DIR ?? join(homedir(), ".cache", "bakeoff-mcp"),
    boardUrl: (env.BAKEOFF_BOARD_URL ?? BOARD_URL).replace(/\/+$/, ""),
  };
}

interface BoardListing {
  id: string;
  practice_set?: string;
  labeling_guide?: string;
}

/**
 * The challenges the board lists for a network, with their practice set and labeling guide as
 * https URLs on the board. The list is the board's, so a challenge it lists appears here without
 * a new release of this server, and the server still serves only listed challenges.
 */
export async function boardChallenges(boardUrl: string, network: Network, fetchImpl: typeof fetch = fetch): Promise<ChallengeConfig[]> {
  const response = await fetchImpl(`${boardUrl}/challenges.json`);
  if (!response.ok) throw new Error(`the board answered HTTP ${response.status}`);
  const listings = ((await response.json()) as Partial<Record<Network, BoardListing[]>>)[network] ?? [];
  const onBoard = (path: string | undefined) => (path ? new URL(path, `${boardUrl}/`).href : undefined);
  return listings.map((l) => ({ id: l.id, practiceSet: onBoard(l.practice_set), labelingGuide: onBoard(l.labeling_guide) }));
}

/**
 * The configuration to run with. A config file (BAKEOFF_MCP_CONFIG) is used as it is. Without
 * one, the challenges come from the board's list for the network, narrowed to BAKEOFF_CHALLENGES
 * when that is set; if the board cannot be read, BAKEOFF_CHALLENGES alone still works, without
 * practice sets.
 */
export async function resolveConfig(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<Config & { source: string }> {
  const config = loadConfig(env);
  if (env.BAKEOFF_MCP_CONFIG) return { ...config, source: env.BAKEOFF_MCP_CONFIG };
  const wanted = config.challenges.map((c) => c.id);
  let listed: ChallengeConfig[];
  try {
    listed = await boardChallenges(config.boardUrl, config.network, fetchImpl);
  } catch (error) {
    if (wanted.length) return { ...config, source: `BAKEOFF_CHALLENGES (the board's list could not be read: ${(error as Error).message})` };
    throw new Error(`could not read the board's list of challenges at ${config.boardUrl}/challenges.json (${(error as Error).message}); set BAKEOFF_MCP_CONFIG or BAKEOFF_CHALLENGES`);
  }
  const challenges = wanted.length ? wanted.map((id) => listed.find((c) => c.id === id) ?? { id }) : listed;
  return { ...config, challenges, source: `${config.boardUrl}/challenges.json` };
}
