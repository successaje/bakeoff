/**
 * What a result page needs beyond the contract's record: the solution's
 * config, how it measured up to each requirement and to the baseline, and
 * the request it sends a model.
 *
 * The contract keeps only the config's SHA-256. The config itself is in the
 * arguments of the transaction that submitted it, so it is found through the
 * explorer's transaction list, read from an archival RPC node, and accepted
 * only if it hashes to the recorded value.
 */

import { type Gates, type Metrics, type Network, sha256Hex } from "./near.ts";
import type { Baseline } from "./registry.ts";

const EXPLORER_API: Record<Network, string> = {
  mainnet: "https://api.nearblocks.io",
  testnet: "https://api-testnet.nearblocks.io",
};

// Ordinary RPC nodes keep only the last few days of transactions.
const ARCHIVAL_RPC: Record<Network, string> = {
  mainnet: "https://archival-rpc.mainnet.fastnear.com",
  testnet: "https://archival-rpc.testnet.fastnear.com",
};

const PAGE = 25;
const MAX_PAGES = 4;

export interface Submission {
  /** The config exactly as submitted. */
  config: string;
  transaction: string;
}

interface ListedTransaction {
  transaction_hash: string;
  signer_account_id: string;
  actions?: { method?: string | null }[];
}

async function submittedConfig(network: Network, hash: string, sender: string, fetchImpl: typeof fetch): Promise<string | null> {
  const response = await fetchImpl(ARCHIVAL_RPC[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "bakeoff-web",
      method: "EXPERIMENTAL_tx_status",
      params: { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" },
    }),
  });
  if (!response.ok) throw new Error(`the archival node answered HTTP ${response.status}`);
  const body = (await response.json()) as {
    result?: { transaction?: { actions?: { FunctionCall?: { method_name: string; args: string } }[] } };
  };
  const call = body.result?.transaction?.actions?.find((a) => a.FunctionCall?.method_name === "submit")?.FunctionCall;
  if (!call) return null;
  try {
    const args = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(call.args), (c) => c.charCodeAt(0)))) as { config_json?: unknown };
    return typeof args.config_json === "string" ? args.config_json : null;
  } catch {
    return null;
  }
}

const found = new Map<string, Promise<Submission | null>>();

/** The submission behind a result, or null if none of the submitter's recent submissions hashes to it. */
export function findSubmission(
  network: Network,
  challenge: string,
  submitter: string,
  configSha256: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<Submission | null> {
  const key = `${network}:${challenge}:${submitter}:${configSha256}`;
  let search = found.get(key);
  if (!search) {
    search = (async () => {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await fetchImpl(`${EXPLORER_API[network]}/v3/accounts/${challenge}/txns?per_page=${PAGE}&page=${page}`);
        if (response.status === 429) throw new Error("the explorer is limiting requests; try again in a minute");
        if (!response.ok) throw new Error(`the explorer answered HTTP ${response.status}`);
        const body = (await response.json()) as { data?: ListedTransaction[]; txns?: ListedTransaction[] };
        const listed = body.data ?? body.txns ?? [];
        for (const tx of listed) {
          if (tx.signer_account_id !== submitter || !tx.actions?.some((a) => a.method === "submit")) continue;
          const config = await submittedConfig(network, tx.transaction_hash, submitter, fetchImpl);
          if (config !== null && (await sha256Hex(config)) === configSha256) return { config, transaction: tx.transaction_hash };
        }
        if (listed.length < PAGE) break;
      }
      return null;
    })();
    found.set(key, search);
    search.catch(() => found.delete(key));
  }
  return search;
}

export interface RequirementCheck {
  label: string;
  needed: string;
  value: string;
  baseline: string | null;
  met: boolean | null;
}

/** Each requirement, what the result scored, and the baseline beside it. */
export function checkRequirements(
  gates: Gates,
  metrics: Metrics | null,
  baseline: Baseline,
  format: { percent: (bp?: number) => string; micro: (u?: number) => string; seconds: (ms?: number) => string },
): RequirementCheck[] {
  const has = (v: number | undefined): v is number => typeof v === "number";
  return [
    {
      label: "Accuracy",
      needed: `≥ ${format.percent(gates.min_accuracy_bp)}`,
      value: format.percent(metrics?.accuracy_bp),
      baseline: baseline.accuracy_bp ? format.percent(baseline.accuracy_bp) : null,
      met: has(metrics?.accuracy_bp) ? metrics.accuracy_bp >= gates.min_accuracy_bp : null,
    },
    {
      label: "Cost per ticket",
      needed: `≤ ${format.micro(gates.max_cost_per_ticket_uusd)}`,
      value: format.micro(metrics?.cost_per_ticket_uusd),
      baseline: baseline.cost_per_ticket_uusd ? format.micro(baseline.cost_per_ticket_uusd) : null,
      met: has(metrics?.cost_per_ticket_uusd) ? metrics.cost_per_ticket_uusd <= gates.max_cost_per_ticket_uusd : null,
    },
    {
      label: "p95 latency",
      needed: `≤ ${format.seconds(gates.max_p95_latency_ms)}`,
      value: format.seconds(metrics?.p95_latency_ms),
      baseline: baseline.p95_latency_ms ? format.seconds(baseline.p95_latency_ms) : null,
      met: has(metrics?.p95_latency_ms) ? metrics.p95_latency_ms <= gates.max_p95_latency_ms : null,
    },
    {
      label: "Card numbers repeated",
      needed: gates.max_leaks === 0 ? "None" : `≤ ${gates.max_leaks}`,
      value: has(metrics?.leaks) ? String(metrics.leaks) : "–",
      baseline: null,
      met: has(metrics?.leaks) ? metrics.leaks <= gates.max_leaks : null,
    },
  ];
}

export interface Change {
  label: string;
  /** Positive when the result is better than the baseline. */
  better: number;
  text: string;
}

/** How the result compares with the baseline the owner published. */
export function compareWithBaseline(metrics: Metrics | null, baseline: Baseline): Change[] {
  const changes: Change[] = [];
  if (metrics?.accuracy_bp !== undefined && baseline.accuracy_bp) {
    const points = (metrics.accuracy_bp - baseline.accuracy_bp) / 100;
    changes.push({ label: "Accuracy", better: points, text: `${points >= 0 ? "+" : "−"}${Math.abs(points).toFixed(1)} points` });
  }
  if (metrics?.cost_per_ticket_uusd !== undefined && baseline.cost_per_ticket_uusd) {
    const cut = Math.round((1 - metrics.cost_per_ticket_uusd / baseline.cost_per_ticket_uusd) * 100);
    changes.push({ label: "Cost per ticket", better: cut, text: cut >= 0 ? `${cut}% cheaper` : `${-cut}% dearer` });
  }
  if (metrics?.p95_latency_ms !== undefined && baseline.p95_latency_ms) {
    const cut = Math.round((1 - metrics.p95_latency_ms / baseline.p95_latency_ms) * 100);
    changes.push({ label: "p95 latency", better: cut, text: cut >= 0 ? `${cut}% faster` : `${-cut}% slower` });
  }
  return changes;
}

interface Rules {
  categories: string[];
  priorities: string[];
  temperature?: number | null;
  endpoint: string;
}

interface CandidateConfig {
  model: string;
  system_prompt: string;
  examples?: { ticket: string; answer: { category: string; priority: string }; summary?: string }[];
  max_tokens?: number;
  request_options?: Record<string, unknown>;
  escalation?: { model: string; below_confidence: number } | null;
}

/** The evaluator's default when a candidate sets no limit (evaluator/src/model.rs). */
const DEFAULT_MAX_TOKENS = 150;

/**
 * The chat request the evaluator sends for one ticket, built the same way as
 * `base_messages` and `output_contract` in evaluator/src/evaluate.rs.
 */
export function chatRequest(rulesJson: string, configJson: string, ticket: string): Record<string, unknown> {
  const rules = JSON.parse(rulesJson) as Rules;
  const config = JSON.parse(configJson) as CandidateConfig;
  const contract =
    `Respond with only a JSON object with these keys: "category" (one of: ${rules.categories.join(", ")}), ` +
    `"priority" (one of: ${rules.priorities.join(", ")}), "confidence" (a number from 0 to 1) and ` +
    `"summary" (one sentence for the support agent). An answer without a summary counts as wrong.`;
  const messages: { role: string; content: string }[] = [{ role: "system", content: `${config.system_prompt.trimEnd()}\n\n${contract}` }];
  for (const example of config.examples ?? []) {
    const answer: Record<string, unknown> = { category: example.answer.category, priority: example.answer.priority, confidence: 1.0 };
    if (example.summary !== undefined) answer.summary = example.summary;
    messages.push({ role: "user", content: example.ticket }, { role: "assistant", content: JSON.stringify(answer) });
  }
  messages.push({ role: "user", content: ticket });
  // Options go in first, so the fields the evaluator sets always win, as in
  // `request_body` in evaluator/src/openai.rs.
  const request: Record<string, unknown> = { ...(config.request_options ?? {}), model: config.model, messages, max_tokens: config.max_tokens ?? DEFAULT_MAX_TOKENS };
  if (typeof rules.temperature === "number") request.temperature = rules.temperature;
  else delete request.temperature;
  return request;
}

export interface ConfigSummary {
  model: string;
  promptCharacters: number;
  examples: number;
  maxTokens: number;
  options: string[];
  escalation: string | null;
}

export function summariseConfig(configJson: string): ConfigSummary {
  const config = JSON.parse(configJson) as CandidateConfig;
  return {
    model: config.model,
    promptCharacters: config.system_prompt.length,
    examples: config.examples?.length ?? 0,
    maxTokens: config.max_tokens ?? DEFAULT_MAX_TOKENS,
    options: Object.entries(config.request_options ?? {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`),
    escalation: config.escalation ? `${config.escalation.model} below ${config.escalation.below_confidence} confidence` : null,
  };
}
