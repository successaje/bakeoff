/**
 * Sealed submissions. The transaction is signed by near-cli-rs from the
 * user's keychain, so this server never handles a private key.
 */

import { spawn } from "node:child_process";
import type { Config } from "./config.ts";
import { sha256Hex } from "./evaluator.ts";
import type { Award, EvaluationView, NearRpc } from "./near.ts";

/** Matches the contract: 0.025 NEAR for OutLayer and 0.01 NEAR for the record. */
export const SUBMIT_DEPOSIT = "0.035 NEAR";
export const SUBMIT_GAS = "300.0 Tgas";

export interface CliResult {
  code: number | null;
  output: string;
}

export interface SubmitDeps {
  rpc: NearRpc;
  runCli: (command: string, args: string[]) => Promise<CliResult>;
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch. */
  now: () => number;
}

export interface SubmissionResult {
  evaluation_id: number | null;
  status: EvaluationView["status"] | "NotRecorded";
  eligible: boolean | null;
  reasons: string[];
  metrics: Record<string, number> | null;
  config_sha256: string;
  transaction: string | null;
  award: (Award & { won_by_this_submission: boolean }) | null;
  note?: string;
}

/** Counts the submissions this process has sent, against `maxSubmissions`. */
export class SubmissionBudget {
  readonly limit: number;
  private sent = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.sent);
  }
  take(): void {
    if (this.sent >= this.limit) {
      throw new Error(
        `this server has sent its ${this.limit} allowed submissions; raise BAKEOFF_MAX_SUBMISSIONS and restart it to send more`,
      );
    }
    this.sent += 1;
  }
}

export function runCli(command: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

const ANSI = /\u001b\[[0-9;]*m/g;

export async function submitCandidate(
  config: Config,
  deps: SubmitDeps,
  budget: SubmissionBudget,
  challengeId: string,
  configJson: string,
  waitSeconds: number,
): Promise<SubmissionResult> {
  if (!config.account) {
    throw new Error("set BAKEOFF_ACCOUNT to the account that signs submissions");
  }
  try {
    JSON.parse(configJson);
  } catch (error) {
    throw new Error(`config_json is not valid JSON: ${(error as Error).message}`);
  }

  const challenge = await deps.rpc.getChallenge(challengeId);
  const isOwner = config.account === challenge.owner;
  if (challenge.status === "Draft" && !isOwner) {
    throw new Error(`${challengeId} is still a draft; only its owner can submit trial runs`);
  }
  if (challenge.status === "Awarded" || challenge.status === "Closed") {
    throw new Error(`${challengeId} is ${challenge.status.toLowerCase()} and takes no more submissions`);
  }
  if (challenge.closes_at !== null && BigInt(deps.now()) * 1_000_000n >= BigInt(challenge.closes_at)) {
    throw new Error(`the deadline for ${challengeId} has passed`);
  }

  budget.take();
  const firstId = challenge.evaluations;
  const configSha = sha256Hex(configJson);
  const { code, output } = await deps.runCli(config.nearCli, [
    "contract", "call-function", "as-transaction", challengeId, "submit",
    "json-args", JSON.stringify({ config_json: configJson }),
    "prepaid-gas", SUBMIT_GAS, "attached-deposit", SUBMIT_DEPOSIT,
    "sign-as", config.account,
    "network-config", config.network,
    config.signWith === "keychain" ? "sign-with-keychain" : "sign-with-legacy-keychain",
    "send",
  ]);
  const clean = output.replace(ANSI, "");
  // The transaction stays open until OutLayer answers, which can outlast the
  // RPC node's wait; that timeout is expected and the contract is polled.
  if (code !== 0 && !/408 Request Timeout|TIMEOUT_ERROR/.test(clean)) {
    const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
    throw new Error(`the submission was not sent: ${lines.filter((l) => /error/i.test(l)).slice(-3).join(" | ") || lines.slice(-3).join(" | ")}`);
  }
  const transaction = /Transaction ID: (\w+)/.exec(clean)?.[1] ?? null;

  // Found by submitter and config hash, not by id: another contributor may
  // submit in the same block.
  const ours = (e: EvaluationView) => e.submitter === config.account && e.config_sha256 === configSha;
  const started = deps.now();
  let evaluation: EvaluationView | undefined;
  while (true) {
    evaluation = (await deps.rpc.getEvaluations(challengeId, firstId, 20)).find(ours);
    if (evaluation && evaluation.status !== "Pending") break;
    const waited = deps.now() - started;
    if (waited >= waitSeconds * 1000) break;
    // An evaluation is recorded in the transaction's first block.
    if (!evaluation && waited >= 60_000) break;
    await deps.sleep(5_000);
  }
  if (!evaluation) {
    return {
      evaluation_id: null, status: "NotRecorded", eligible: null, reasons: [], metrics: null,
      config_sha256: configSha, transaction, award: null,
      note: "near-cli sent the transaction but no evaluation was recorded; check the transaction on the explorer",
    };
  }

  const verdict = evaluation.verdict ? (JSON.parse(evaluation.verdict) as { metrics?: Record<string, number> | null }) : null;
  const result: SubmissionResult = {
    evaluation_id: evaluation.id,
    status: evaluation.status,
    eligible: evaluation.eligible,
    reasons: evaluation.reasons,
    metrics: verdict?.metrics ?? null,
    config_sha256: configSha,
    transaction,
    award: null,
  };
  if (evaluation.status === "Pending") {
    result.note = `no verdict within ${waitSeconds} s; call get_evaluations later for evaluation ${evaluation.id}`;
    return result;
  }
  if (evaluation.status === "Passed" && evaluation.eligible) {
    // The payout is its own transfer, a block or two after the verdict.
    for (let i = 0; i < 6; i++) {
      const { award } = await deps.rpc.getChallenge(challengeId);
      if (award) {
        result.award = { ...award, won_by_this_submission: award.evaluation === evaluation.id };
        if (award.paid || award.evaluation !== evaluation.id) break;
      }
      await deps.sleep(3_000);
    }
  }
  return result;
}
