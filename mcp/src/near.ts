/** Read access to challenge contracts over NEAR JSON-RPC. */

export interface EvaluatorBuild {
  url: string;
  sha256: string;
}

/** How a winner is paid: NEAR, or wNEAR into their NEAR Intents balance. */
export type Payout = "Near" | "Intents";

export interface Award {
  evaluation: number;
  winner: string;
  /** yoctoNEAR, as a decimal string. */
  amount: string;
  paid: boolean;
  in_flight: boolean;
  /** Absent on challenges deployed before Intents payouts. */
  payout?: Payout;
  /** yoctoNEAR deposited into the winner's NEAR Intents balance. */
  to_intents?: string;
  /** yoctoNEAR spent registering the challenge with the wNEAR token. */
  fee?: string;
  /** yoctoNEAR of wNEAR the Intents verifier refused, owed to the winner as NEAR. */
  wrapped?: string;
  /** yoctoNEAR of `amount` taken as the service fee; absent on challenges deployed before fees. */
  service_fee?: string;
  service_fee_sent?: boolean;
}

export type ChallengeStatus = "Draft" | "Open" | "Awarded" | "Closed";
export type EvaluationStatus = "Pending" | "Passed" | "Failed" | "Rejected";

/** `get_challenge` as the contract returns it. */
export interface ChallengeView {
  owner: string;
  status: ChallengeStatus;
  outlayer: string;
  evaluator: EvaluatorBuild;
  secrets: { profile: string; owner: string };
  rules_json: string;
  rules_sha256: string;
  test_set_sha256: string;
  evaluations: number;
  pending: number;
  bounty: string;
  /** Nanoseconds since the Unix epoch. */
  closes_at: string | null;
  award: Award | null;
  /** Where winners may be paid into NEAR Intents; absent or null where they cannot. */
  intents?: { wrap: string; verifier: string } | null;
  /** A share of a won bounty, in basis points, paid to `account`; absent or null where there is none. */
  service_fee?: { account: string; bps: number } | null;
}

/** One entry of `get_evaluations` as the contract returns it. */
export interface EvaluationView {
  id: number;
  submitter: string;
  config_sha256: string;
  eligible: boolean;
  status: EvaluationStatus;
  reasons: string[];
  verdict: string | null;
  requested_at: string;
  settled_at: string | null;
  /** Absent on challenges deployed before Intents payouts. */
  payout?: Payout;
}

export class NearRpc {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.fetchImpl = fetchImpl;
  }

  private async query<R>(what: string, params: object): Promise<R> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "bakeoff-mcp", method: "query", params: { finality: "final", ...params } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`NEAR RPC answered ${response.status} for ${what}`);
    }
    const body = (await response.json()) as {
      error?: { message?: string; data?: unknown; cause?: { name?: string } };
      result?: R & { error?: string };
    };
    if (body.error) {
      const detail = body.error.cause?.name ?? JSON.stringify(body.error.data ?? body.error.message);
      throw new Error(`${what} failed: ${detail}`);
    }
    if (body.result?.error) {
      throw new Error(`${what} failed: ${body.result.error}`);
    }
    return body.result as R;
  }

  async view<T>(accountId: string, method: string, args: object = {}): Promise<T> {
    const result = await this.query<{ result?: number[] }>(`${accountId}.${method}`, {
      request_type: "call_function",
      account_id: accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(result.result ?? []).toString("utf8")) as T;
  }

  /** The account's code hash, or the hash of the shared global contract it uses. */
  async codeHash(accountId: string): Promise<string> {
    const account = await this.query<{ code_hash: string; global_contract_hash?: string | null }>(accountId, {
      request_type: "view_account",
      account_id: accountId,
    });
    return account.global_contract_hash || account.code_hash;
  }

  getChallenge(id: string): Promise<ChallengeView> {
    return this.view<ChallengeView>(id, "get_challenge");
  }

  getEvaluations(id: string, fromIndex = 0, limit = 50): Promise<EvaluationView[]> {
    return this.view<EvaluationView[]>(id, "get_evaluations", {
      from_index: fromIndex,
      limit,
    });
  }
}

const YOCTO_PER_NEAR = 10n ** 24n;

/** "1000000000000000000000000" -> "1 NEAR"; at most five decimals. */
export function formatNear(yocto: string): string {
  const value = BigInt(yocto);
  const whole = value / YOCTO_PER_NEAR;
  const fraction = (value % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, 5).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} NEAR`;
}

/** Nanoseconds since the epoch, as the contract stores them, to ISO 8601. */
export function nsToIso(ns: string | null): string | null {
  return ns === null ? null : new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}
