/** Read access to challenge contracts over NEAR JSON-RPC. */

export interface EvaluatorBuild {
  url: string;
  sha256: string;
}

export interface Award {
  evaluation: number;
  winner: string;
  /** yoctoNEAR, as a decimal string. */
  amount: string;
  paid: boolean;
  in_flight: boolean;
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
}

export class NearRpc {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.fetchImpl = fetchImpl;
  }

  async view<T>(accountId: string, method: string, args: object = {}): Promise<T> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "bakeoff-mcp",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: accountId,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`NEAR RPC answered ${response.status} for ${accountId}.${method}`);
    }
    const body = (await response.json()) as {
      error?: { message?: string; data?: unknown; cause?: { name?: string } };
      result?: { result?: number[]; error?: string };
    };
    if (body.error) {
      const detail = body.error.cause?.name ?? JSON.stringify(body.error.data ?? body.error.message);
      throw new Error(`${accountId}.${method} failed: ${detail}`);
    }
    if (body.result?.error) {
      throw new Error(`${accountId}.${method} failed: ${body.result.error}`);
    }
    return JSON.parse(Buffer.from(body.result?.result ?? []).toString("utf8")) as T;
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
