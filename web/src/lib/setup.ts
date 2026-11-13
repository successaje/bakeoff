/**
 * Setting up a challenge: what the host decides, checked and turned into the
 * files and commands the setup scripts take.
 *
 * Everything here is plain data. The hidden test cases and the model API key
 * never pass through it: the scripts read them on the host's machine, and the
 * OutLayer CLI encrypts them for the evaluator there.
 */

import type { Gates, Network } from "./near.ts";
import type { Baseline } from "./registry.ts";

export type Goal = "cheaper" | "faster" | "accurate" | "custom";

export interface ModelRow { id: string; input: string; output: string; on: boolean }

/** The form as typed: strings, so a half-typed number stays as the host left it. */
export interface Draft {
  network: Network;
  account: string;
  name: string;
  title: string;
  sponsor: string;
  summary: string;
  problem: string;
  tags: string;
  categories: string;
  priorities: string;
  tickets: string;
  models: ModelRow[];
  options: string[];
  /** The baseline's median metrics: accuracy in %, cost in µ$ a ticket, p95 in seconds. */
  baseline: { accuracy: string; cost: string; p95: string };
  goal: Goal;
  /** Cheaper: the cut in cost, in %. */
  cut: string;
  /** Faster: the p95 to beat, in seconds. */
  fastP95: string;
  /** More accurate: the accuracy to reach, in %. */
  accuracyTarget: string;
  /** Custom: every requirement set by hand, in the same units as the baseline. */
  custom: { accuracy: string; cost: string; p95: string };
  reward: string;
  days: string;
  timeBudget: string;
  concurrency: string;
  maxTokens: string;
  temperature: string;
}

export const ENDPOINT = "https://cloud-api.near.ai/v1/chat/completions";
/** Request fields builders may set per call, beyond what the evaluator sets itself. */
export const REQUEST_OPTIONS = ["reasoning_effort", "thinking_token_budget", "chat_template_kwargs"];
/** The evaluator's own limits (evaluator/src/policy.rs). */
export const LIMITS = { timeBudgetS: 100, concurrency: 32 };
/** How much accuracy a cheaper or faster solution may give up, as calibrate.py's default. */
export const ACCURACY_TOLERANCE_BP = 200;
export const TEST_SET_PATH = "data/private/sealed.json";
export const BASELINE_PATH = "your-agent.json";

const NEAR_AI_MODELS: ModelRow[] = [
  { id: "qwen/qwen3.5-397b-a17b", input: "0.5", output: "3.3", on: true },
  { id: "Qwen/Qwen3.6-35B-A3B-FP8", input: "0.17", output: "1.1", on: true },
  { id: "z-ai/glm-5.3-flash", input: "0.08", output: "0.5", on: true },
];

export function suffix(network: Network): string {
  return network === "mainnet" ? ".near" : ".testnet";
}

/** A fresh draft, with the triage task's defaults and the account the host is signed in with. */
export function emptyDraft(network: Network, account: string | null, now = new Date()): Draft {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  return {
    network,
    account: account?.endsWith(suffix(network)) ? account : "",
    name: `challenge-${stamp}`,
    title: "",
    sponsor: "",
    summary: "",
    problem: "",
    tags: "Classification, Customer support, Private test set",
    categories: "billing, shipping, returns, account, technical, other",
    priorities: "low, normal, high, urgent",
    tickets: "100",
    models: NEAR_AI_MODELS.map((m) => ({ ...m })),
    options: [...REQUEST_OPTIONS],
    baseline: { accuracy: "", cost: "", p95: "" },
    goal: "cheaper",
    cut: "25",
    fastP95: "3",
    accuracyTarget: "92",
    custom: { accuracy: "", cost: "", p95: "" },
    reward: "5",
    days: "30",
    timeBudget: "75",
    concurrency: "16",
    maxTokens: "600",
    temperature: "0",
  };
}

/** A number typed into the form, or null when it is not one. */
export function num(text: string): number | null {
  const t = text.trim();
  if (t === "" || !/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function list(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

/** NEAR account rules: lowercase letters, digits and - _ between dot-separated parts, 2 to 64 characters. */
export function isAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

export function challengeId(draft: Draft): string {
  return `${draft.name.trim()}.${draft.account.trim()}`;
}

/** The baseline in the units the contract and listing use, once all three metrics are numbers. */
export function baselineOf(draft: Draft): Baseline | null {
  const accuracy = num(draft.baseline.accuracy), cost = num(draft.baseline.cost), p95 = num(draft.baseline.p95);
  if (accuracy === null || cost === null || p95 === null || accuracy > 100 || cost <= 0 || p95 <= 0) return null;
  return { accuracy_bp: Math.round(accuracy * 100), cost_per_ticket_uusd: Math.round(cost), p95_latency_ms: Math.round(p95 * 1000) };
}

/** Accuracy a solution must keep when the goal is cost or speed: the baseline's, less the tolerance, rounded down to a whole point. */
function keptAccuracy(base: Baseline): number {
  return Math.max(0, Math.floor((base.accuracy_bp - ACCURACY_TOLERANCE_BP) / 100) * 100);
}

/**
 * The requirements for the chosen goal. Cheaper is calibrate.py's own policy:
 * accuracy within two points, cost cut by the given share, p95 no worse.
 * Faster and more accurate move one requirement and hold the others at the
 * baseline.
 */
export function gatesOf(draft: Draft): Gates | null {
  if (draft.goal === "custom") {
    const accuracy = num(draft.custom.accuracy), cost = num(draft.custom.cost), p95 = num(draft.custom.p95);
    if (accuracy === null || cost === null || p95 === null) return null;
    return { min_accuracy_bp: Math.round(accuracy * 100), max_cost_per_ticket_uusd: Math.round(cost), max_p95_latency_ms: Math.round(p95 * 1000), max_leaks: 0 };
  }
  const base = baselineOf(draft);
  if (!base) return null;
  if (draft.goal === "cheaper") {
    const cut = num(draft.cut);
    if (cut === null) return null;
    return { min_accuracy_bp: keptAccuracy(base), max_cost_per_ticket_uusd: Math.floor(base.cost_per_ticket_uusd * (1 - cut / 100)), max_p95_latency_ms: base.p95_latency_ms, max_leaks: 0 };
  }
  if (draft.goal === "faster") {
    const p95 = num(draft.fastP95);
    if (p95 === null) return null;
    return { min_accuracy_bp: keptAccuracy(base), max_cost_per_ticket_uusd: base.cost_per_ticket_uusd, max_p95_latency_ms: Math.round(p95 * 1000), max_leaks: 0 };
  }
  const target = num(draft.accuracyTarget);
  if (target === null) return null;
  return { min_accuracy_bp: Math.round(target * 100), max_cost_per_ticket_uusd: base.cost_per_ticket_uusd, max_p95_latency_ms: base.p95_latency_ms, max_leaks: 0 };
}

export interface Issue { section: string; text: string }

/** What still stands between the draft and a challenge the scripts and evaluator accept. */
export function issuesOf(draft: Draft): Issue[] {
  const issues: Issue[] = [];
  const add = (section: string, text: string) => issues.push({ section, text });
  const account = draft.account.trim();
  if (!account) add("challenge", "Enter the NEAR account that will own the challenge.");
  else if (!isAccountId(account)) add("challenge", `${account} is not a valid NEAR account name.`);
  else if (!account.endsWith(suffix(draft.network))) add("challenge", `On ${draft.network}, the owner's account ends in ${suffix(draft.network)}.`);
  if (!/^[a-z\d]+([-_][a-z\d]+)*$/.test(draft.name.trim())) add("challenge", "The challenge name takes lowercase letters, digits, and - or _ between them.");
  else if (account && challengeId(draft).length > 64) add("challenge", "The challenge's account name, with yours after it, must stay within 64 characters.");
  if (!draft.title.trim()) add("challenge", "Give the challenge a title.");
  if (!draft.sponsor.trim()) add("challenge", "Name the team or company setting the goal.");
  if (!draft.summary.trim()) add("challenge", "Write a one-paragraph summary for the board.");

  const categories = list(draft.categories), priorities = list(draft.priorities);
  if (!categories.length) add("task", "List at least one category.");
  if (new Set(categories).size !== categories.length) add("task", "Each category must be different.");
  if (!priorities.length) add("task", "List at least one priority.");
  if (new Set(priorities).size !== priorities.length) add("task", "Each priority must be different.");
  const tickets = num(draft.tickets);
  if (tickets === null || !Number.isInteger(tickets) || tickets < 1) add("task", "Enter how many hidden test cases there are.");

  const models = draft.models.filter((m) => m.on);
  if (!models.length) add("models", "Allow at least one model.");
  if (models.some((m) => !m.id.trim())) add("models", "Every allowed model needs its name.");
  if (new Set(models.map((m) => m.id.trim())).size !== models.length) add("models", "A model is listed twice.");
  if (models.some((m) => num(m.input) === null || num(m.output) === null)) add("models", "Every allowed model needs its input and output price.");
  const budget = num(draft.timeBudget), concurrency = num(draft.concurrency), maxTokens = num(draft.maxTokens);
  if (budget === null || budget <= 0 || budget > LIMITS.timeBudgetS) add("models", `The time budget must be more than 0 and at most ${LIMITS.timeBudgetS} seconds.`);
  if (concurrency === null || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > LIMITS.concurrency) add("models", `Calls at once must be a whole number from 1 to ${LIMITS.concurrency}.`);
  if (maxTokens === null || !Number.isInteger(maxTokens) || maxTokens < 1) add("models", "The reply length cap must be a whole number of tokens.");
  if (draft.temperature.trim() !== "") {
    const t = num(draft.temperature);
    if (t === null || t > 2) add("models", "Temperature must be between 0 and 2, or left empty.");
  }

  const base = baselineOf(draft);
  // The listing publishes the baseline whatever the goal, so builders see what they are measured against.
  if (!base) add("goal", "Enter your baseline's accuracy, cost and p95, or paste calibration's report.");
  if (base) {
    if (draft.goal === "cheaper") {
      const cut = num(draft.cut);
      if (cut === null || cut <= 0 || cut >= 100) add("goal", "The cost cut must be between 0 and 100%.");
    }
    if (draft.goal === "faster") {
      const p95 = num(draft.fastP95);
      if (p95 === null || p95 <= 0) add("goal", "Enter the p95 to beat, in seconds.");
      else if (Math.round(p95 * 1000) >= base.p95_latency_ms) add("goal", "The p95 to beat must be faster than your baseline's.");
    }
    if (draft.goal === "accurate") {
      const target = num(draft.accuracyTarget);
      if (target === null || target > 100) add("goal", "Enter the accuracy to reach, up to 100%.");
      else if (Math.round(target * 100) <= base.accuracy_bp) add("goal", "The accuracy to reach must be above your baseline's.");
    }
  }
  if (draft.goal === "custom") {
    const g = gatesOf(draft);
    if (!g) add("goal", "Set all three requirements.");
    else if (g.min_accuracy_bp > 10_000) add("goal", "Accuracy cannot exceed 100%.");
  }

  const reward = num(draft.reward), days = num(draft.days);
  if (reward === null || reward <= 0) add("reward", "Enter the reward in NEAR.");
  if (days === null || !Number.isInteger(days) || days < 1) add("reward", "Enter how many whole days the challenge stays open.");
  return issues;
}

/** The rules file, in the order and shape of examples/rules/near-ai.json. */
export function rulesOf(draft: Draft): Record<string, unknown> {
  const models: Record<string, { input_usd_per_mtok: number | null; output_usd_per_mtok: number | null }> = {};
  for (const m of draft.models.filter((row) => row.on && row.id.trim())) {
    models[m.id.trim()] = { input_usd_per_mtok: num(m.input), output_usd_per_mtok: num(m.output) };
  }
  const budget = num(draft.timeBudget);
  const rules: Record<string, unknown> = {
    version: 1,
    endpoint: ENDPOINT,
    models,
    allowed_tools: [],
    allowed_request_options: REQUEST_OPTIONS.filter((o) => draft.options.includes(o)),
    categories: list(draft.categories),
    priorities: list(draft.priorities),
    gates: gatesOf(draft) ?? { min_accuracy_bp: null, max_cost_per_ticket_uusd: null, max_p95_latency_ms: null, max_leaks: 0 },
    time_budget_ms: budget === null ? null : Math.round(budget * 1000),
    max_concurrency: num(draft.concurrency),
    max_tokens_cap: num(draft.maxTokens),
  };
  const temperature = num(draft.temperature);
  if (draft.temperature.trim() !== "" && temperature !== null) rules.temperature = temperature;
  return rules;
}

/** The entry for web/public/challenges.json, under the challenge's network. */
export function listingOf(draft: Draft): Record<string, unknown> {
  const base = baselineOf(draft);
  const entry: Record<string, unknown> = {
    id: challengeId(draft),
    title: draft.title.trim(),
    sponsor: draft.sponsor.trim(),
    summary: draft.summary.trim(),
    tickets: num(draft.tickets),
    baseline: base ?? { accuracy_bp: null, cost_per_ticket_uusd: null, p95_latency_ms: null },
  };
  if (draft.problem.trim()) entry.problem = draft.problem.trim();
  const tags = list(draft.tags);
  if (tags.length) entry.tags = tags;
  return entry;
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The scripts to run, in order, with this draft's values filled in. */
export function commandsOf(draft: Draft): string {
  const account = draft.account.trim() || `you${suffix(draft.network)}`;
  const network = `NETWORK=${draft.network}`;
  // On mainnet the scripts that spend NEAR want the signer named twice.
  const confirm = draft.network === "mainnet" ? ` MAINNET_CONFIRM=${account}` : "";
  return [
    "# 0. Once: save your NEAR AI Cloud key in .env.",
    "#    You type it here; it is never shown.",
    "scripts/set-api-key.sh",
    "",
    "# 1. Measure your current agent, three runs.",
    "#    Then paste report.json into the form.",
    "cargo build -p bakeoff-evaluator \\",
    "  --target wasm32-wasip2 --release",
    "set -a; . ./.env; set +a",
    "python3 tools/calibrate.py --runs 3 \\",
    "  --rules rules.json \\",
    `  --baseline ${BASELINE_PATH} \\`,
    `  --test-set ${TEST_SET_PATH} \\`,
    "  --out calibrated-rules.json --report report.json",
    "",
    "# 2. Deploy, with the form's rules.json.",
    `${network}${confirm} BAKEOFF_ACCOUNT=${account} \\`,
    `CHALLENGE_NAME=${draft.name.trim() || "challenge-name"} \\`,
    "RULES_FILE=rules.json \\",
    `TEST_SET_FILE=${TEST_SET_PATH} \\`,
    "  scripts/near/deploy.sh",
    "",
    "# 3. Seal the test cases and key with OutLayer.",
    `${network} scripts/near/store-secrets.sh`,
    "",
    "# 4. A trial run. The owner's runs never win.",
    `${network}${confirm} scripts/near/submit.sh ${BASELINE_PATH}`,
  ].join("\n");
}

export function lockCommand(draft: Draft): string {
  const account = draft.account.trim() || `you${suffix(draft.network)}`;
  const confirm = draft.network === "mainnet" ? ` MAINNET_CONFIRM=${account}` : "";
  return `NETWORK=${draft.network}${confirm} scripts/near/lock.sh`;
}

/** Reads the baseline from calibrate.py's report.json, in the form's units. */
export function baselineFromReport(text: string): Draft["baseline"] | null {
  try {
    const metrics = (JSON.parse(text) as { baseline_metrics?: Partial<Baseline> }).baseline_metrics;
    if (!metrics || typeof metrics.accuracy_bp !== "number" || typeof metrics.cost_per_ticket_uusd !== "number" || typeof metrics.p95_latency_ms !== "number") return null;
    return {
      accuracy: String(metrics.accuracy_bp / 100),
      cost: String(metrics.cost_per_ticket_uusd),
      p95: String(metrics.p95_latency_ms / 1000),
    };
  } catch {
    return null;
  }
}
