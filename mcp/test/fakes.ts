/** Test doubles for the chain, near-cli and the evaluator. */

import type { Config } from "../src/config.ts";
import type { ChallengeView, EvaluationView, NearRpc } from "../src/near.ts";
import type { CliResult } from "../src/submit.ts";

export const CHALLENGE = "challenge.bakeoff.testnet";
export const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

export const RULES = {
  version: 1,
  endpoint: "https://cloud-api.near.ai/v1/chat/completions",
  models: { "z-ai/glm-5.3-flash": { input_usd_per_mtok: 0.08, output_usd_per_mtok: 0.5 } },
  categories: ["billing", "shipping"],
  priorities: ["low", "high"],
  gates: { min_accuracy_bp: 8500, max_cost_per_ticket_uusd: 96, max_p95_latency_ms: 18159, max_leaks: 0 },
};

export function challengeView(overrides: Partial<ChallengeView> = {}): ChallengeView {
  return {
    owner: "sponsor.testnet",
    status: "Open",
    outlayer: "outlayer.testnet",
    evaluator: { url: "https://fastfs.example/evaluator.wasm", sha256: "0".repeat(64) },
    secrets: { profile: "bakeoff", owner: "sponsor.testnet" },
    rules_json: JSON.stringify(RULES),
    rules_sha256: "1".repeat(64),
    test_set_sha256: "2".repeat(64),
    evaluations: 0,
    pending: 0,
    bounty: "1000000000000000000000000",
    closes_at: String(BigInt(NOW + 3_600_000) * 1_000_000n),
    award: null,
    ...overrides,
  };
}

export function evaluation(overrides: Partial<EvaluationView> = {}): EvaluationView {
  return {
    id: 0,
    submitter: "agent.testnet",
    config_sha256: "",
    eligible: true,
    status: "Pending",
    reasons: [],
    verdict: null,
    requested_at: "1",
    settled_at: null,
    ...overrides,
  };
}

/** A chain whose views follow scripted sequences; the last value repeats. */
export class FakeChain {
  challenges: ChallengeView[] = [challengeView()];
  evaluationPages: EvaluationView[][] = [[]];
  calls: string[] = [];

  getChallenge(id: string): Promise<ChallengeView> {
    this.calls.push(`get_challenge ${id}`);
    const next = this.challenges.length > 1 ? this.challenges.shift()! : this.challenges[0]!;
    return Promise.resolve(next);
  }

  getEvaluations(id: string, from: number, limit: number): Promise<EvaluationView[]> {
    this.calls.push(`get_evaluations ${id} ${from} ${limit}`);
    const next = this.evaluationPages.length > 1 ? this.evaluationPages.shift()! : this.evaluationPages[0]!;
    return Promise.resolve(next);
  }

  asRpc(): NearRpc {
    return this as unknown as NearRpc;
  }
}

export class FakeCli {
  invocations: { command: string; args: string[] }[] = [];
  result: CliResult;

  constructor(result: CliResult = { code: 0, output: "Transaction ID: 7xTxHash\n" }) {
    this.result = result;
  }

  run = (command: string, args: string[]): Promise<CliResult> => {
    this.invocations.push({ command, args });
    return Promise.resolve(this.result);
  };
}

/** A clock that only moves when the code under test sleeps. */
export class FakeClock {
  ms = NOW;
  now = () => this.ms;
  sleep = (ms: number) => {
    this.ms += ms;
    return Promise.resolve();
  };
}

export function config(overrides: Partial<Config> = {}): Config {
  return {
    network: "testnet",
    rpcUrl: "https://rpc.example",
    challenges: [{ id: CHALLENGE }],
    account: "agent.testnet",
    llmApiKey: "test-key",
    nearCli: "near",
    signWith: "keychain",
    wasmtime: "wasmtime",
    maxSubmissions: 3,
    cacheDir: "/nonexistent",
    ...overrides,
  };
}
