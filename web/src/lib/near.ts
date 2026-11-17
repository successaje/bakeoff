/** Read access to challenge contracts, and the units people read them in. */

export type Network = "testnet" | "mainnet";

export const NETWORKS: Record<Network, { rpc: string; rpcFallback: string; explorer: string; wrap: string }> = {
  // FastNEAR answers view calls about four times faster than NEAR's own public endpoints, with
  // open CORS, but refuses bursts; NEAR's endpoints take over while it rests.
  testnet: { rpc: "https://test.rpc.fastnear.com", rpcFallback: "https://rpc.testnet.near.org", explorer: "https://testnet.nearblocks.io", wrap: "wrap.testnet" },
  mainnet: { rpc: "https://free.rpc.fastnear.com", rpcFallback: "https://rpc.mainnet.near.org", explorer: "https://nearblocks.io", wrap: "wrap.near" },
};

export interface Award {
  evaluation: number;
  winner: string;
  amount: string;
  paid: boolean;
  in_flight: boolean;
}

export type ChallengeStatus = "Draft" | "Open" | "Awarded" | "Closed";

export interface ChallengeView {
  owner: string;
  status: ChallengeStatus;
  outlayer: string;
  evaluator: { url: string; sha256: string };
  secrets: { profile: string; owner: string };
  rules_json: string;
  rules_sha256: string;
  test_set_sha256: string;
  evaluations: number;
  /** Absent on challenges deployed before bounties existed. */
  pending?: number;
  bounty?: string;
  closes_at?: string | null;
  award?: Award | null;
}

export interface EvaluationView {
  id: number;
  submitter: string;
  config_sha256: string;
  /** Absent on challenges deployed before bounties existed. */
  eligible?: boolean;
  status: "Pending" | "Passed" | "Failed" | "Rejected";
  reasons: string[];
  verdict: string | null;
  requested_at: string;
  settled_at: string | null;
}

export interface Gates {
  min_accuracy_bp: number;
  max_cost_per_ticket_uusd: number;
  max_p95_latency_ms: number;
  max_leaks: number;
}

/** NEAR says the account, its contract or the method does not exist: there is truly nothing to show. */
export function isMissingAccount(error: unknown): boolean {
  return /UNKNOWN_ACCOUNT|does not exist|MethodNotFound|CodeDoesNotExist|wasm execution failed/.test(error instanceof Error ? error.message : String(error));
}

/** Calls in flight at once per endpoint. Free public RPCs refuse bursts of a few dozen. */
const MAX_IN_FLIGHT = 4;
/** Waits before each retry of a refused call, in ms; each is spread by ±25% so retries do not land together. */
const RETRY_DELAYS_MS = [400, 1000, 2200, 4500];
/** How long an endpoint that refused a call is left alone while the others take the calls. */
const REST_MS = 8_000;

type RpcBody<T> = { error?: { cause?: { name?: string }; message?: string }; result?: T & { error?: string } };

export class NearRpc {
  /** The preferred endpoint; the others are used while it rests. */
  readonly url: string;
  readonly urls: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelaysMs: number[];
  private readonly restMs: number;
  private readonly resting = new Map<string, number>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(urls: string | string[], fetchImpl: typeof fetch = fetch.bind(globalThis), options: { retryDelaysMs?: number[]; restMs?: number } = {}) {
    this.urls = typeof urls === "string" ? [urls] : urls;
    this.url = this.urls[0]!;
    this.fetchImpl = fetchImpl;
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.restMs = options.restMs ?? REST_MS;
  }

  /** The first endpoint not resting; when all are, they take turns. */
  private endpoint(attempt: number): { url: string; others: boolean } {
    const now = Date.now();
    const awake = this.urls.filter((u) => (this.resting.get(u) ?? 0) <= now);
    return { url: awake[0] ?? this.urls[attempt % this.urls.length]!, others: awake.length > 1 };
  }

  /** Rests an endpoint that refused a call. Returns true when another can take the retry now. */
  private refused(url: string): boolean {
    this.resting.set(url, Date.now() + this.restMs);
    const now = Date.now();
    return this.urls.some((u) => (this.resting.get(u) ?? 0) <= now);
  }

  /** Runs one call once fewer than MAX_IN_FLIGHT are running, so a page's reads queue instead of bursting. */
  private async slot<R>(work: () => Promise<R>): Promise<R> {
    if (this.active >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private pause(attempt: number): Promise<void> {
    const ms = this.retryDelaysMs[attempt]! * (0.75 + Math.random() * 0.5);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async query<T>(params: object, label: string): Promise<T> {
    const request = JSON.stringify({ jsonrpc: "2.0", id: "bakeoff-web", method: "query", params: { finality: "final", ...params } });
    for (let attempt = 0; ; attempt++) {
      const retryable = attempt < this.retryDelaysMs.length;
      const { url } = this.endpoint(attempt);
      // A refused call goes straight to an endpoint that is not resting, or waits if none is.
      const retry = async () => { if (!this.refused(url)) await this.pause(attempt); };
      let reply: { status: number; body: RpcBody<T> | null };
      try {
        reply = await this.slot(async () => {
          const response = await this.fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: request });
          return { status: response.status, body: response.ok ? ((await response.json()) as RpcBody<T>) : null };
        });
      } catch (error) {
        // A rate limit answered without CORS headers reaches the page as a network error, so a
        // failed request is retried like a 429.
        if (retryable) { await retry(); continue; }
        throw new Error(`NEAR RPC could not be reached (${(error as Error).message})`);
      }
      if (reply.status === 429 || reply.status >= 500) {
        if (retryable) { await retry(); continue; }
        throw new Error(`NEAR RPC answered ${reply.status}`);
      }
      if (!reply.body) throw new Error(`NEAR RPC answered ${reply.status}`);
      const { error, result } = reply.body;
      if (error) {
        const name = error.cause?.name ?? error.message ?? "";
        if (retryable && /TIMEOUT|TOO_MANY_REQUESTS|NO_SYNCED_BLOCKS/.test(name)) { await retry(); continue; }
        throw new Error(`${label}: ${name}`);
      }
      if (result?.error) throw new Error(`${label}: ${result.error}`);
      return result as T;
    }
  }

  async view<T>(accountId: string, method: string, args: object = {}): Promise<T> {
    const result = await this.query<{ result?: number[] }>(
      { request_type: "call_function", account_id: accountId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
      `${accountId}.${method}`,
    );
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result ?? []))) as T;
  }

  /**
   * The account's access keys. A contract account with none is locked: nobody
   * can deploy other code to it or sign as it.
   */
  async accessKeys(accountId: string): Promise<{ publicKey: string; fullAccess: boolean }[]> {
    const result = await this.query<{ keys?: { public_key: string; access_key: { permission: unknown } }[] }>(
      { request_type: "view_access_key_list", account_id: accountId },
      `${accountId} access keys`,
    );
    return (result.keys ?? []).map((k) => ({ publicKey: k.public_key, fullAccess: k.access_key.permission === "FullAccess" }));
  }

  getChallenge(id: string): Promise<ChallengeView> {
    return this.view(id, "get_challenge");
  }

  /** All evaluations, a page of 100 at a time. */
  async getAllEvaluations(id: string, total: number): Promise<EvaluationView[]> {
    const pages: Promise<EvaluationView[]>[] = [];
    for (let from = 0; from < total; from += 100) {
      pages.push(this.view(id, "get_evaluations", { from_index: from, limit: 100 }));
    }
    return (await Promise.all(pages)).flat();
  }

  ftBalance(token: string, accountId: string): Promise<string> {
    return this.view(token, "ft_balance_of", { account_id: accountId });
  }

  storageBalance(token: string, accountId: string): Promise<{ total: string } | null> {
    return this.view(token, "storage_balance_of", { account_id: accountId });
  }
}

const YOCTO = 10n ** 24n;

/** "1000000000000000000000000" -> "1 NEAR"; at most five decimals. */
export function formatNear(yocto: string | bigint): string {
  const value = BigInt(yocto);
  const fraction = (value % YOCTO).toString().padStart(24, "0").slice(0, 5).replace(/0+$/, "");
  return `${value / YOCTO}${fraction ? `.${fraction}` : ""} NEAR`;
}

/** "1.5" -> 1500000000000000000000000n. Refuses anything but a plain positive decimal. */
export function parseNear(text: string): bigint {
  const match = /^\s*(\d+)(?:\.(\d{1,24}))?\s*$/.exec(text);
  if (!match) throw new Error("enter an amount of NEAR such as 1 or 0.5");
  const value = BigInt(match[1]!) * YOCTO + BigInt((match[2] ?? "").padEnd(24, "0"));
  if (value === 0n) throw new Error("the amount must be more than zero");
  return value;
}

export function nsToDate(ns: string | null | undefined): Date | null {
  return ns ? new Date(Number(BigInt(ns) / 1_000_000n)) : null;
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Metrics {
  accuracy_bp?: number;
  category_accuracy_bp?: number;
  cost_per_ticket_uusd?: number;
  p95_latency_ms?: number;
  leaks?: number;
  invalid_answers?: number;
  tickets?: number;
}

export function verdictMetrics(evaluation: EvaluationView): Metrics | null {
  if (!evaluation.verdict) return null;
  try {
    return ((JSON.parse(evaluation.verdict) as { metrics?: Metrics | null }).metrics ?? null);
  } catch {
    return null;
  }
}

export function challengeGates(view: ChallengeView): Gates | null {
  return (JSON.parse(view.rules_json) as { gates?: Gates }).gates ?? null;
}

/** Open, and before its deadline. */
export function acceptingSubmissions(view: ChallengeView, now = Date.now()): boolean {
  const closes = nsToDate(view.closes_at);
  return view.status === "Open" && (closes === null || now < closes.getTime());
}
