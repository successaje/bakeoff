import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ChallengeConfig, Config } from "./config.ts";
import { ensureEvaluator, readMaterial, runEvaluator, sha256Hex } from "./evaluator.ts";
import { type ChallengeView, formatNear, NearRpc, nsToIso } from "./near.ts";
import { SUBMIT_DEPOSIT, SubmissionBudget, type SubmitDeps, submitCandidate } from "./submit.ts";

export interface ServerDeps extends SubmitDeps {
  fetchImpl: typeof fetch;
  runEvaluator: typeof runEvaluator;
}

/** Limits the evaluator applies when a challenge's rules leave them out. */
const RULE_DEFAULTS = {
  time_budget_ms: 75_000,
  max_concurrency: 8,
  max_tokens_cap: 400,
  max_prompt_chars: 16_000,
  max_examples: 8,
  allowed_tools: [],
  allowed_request_options: [],
};

const CANDIDATE_FORMAT = {
  version: "1",
  model: "one of the challenge's models",
  system_prompt: "string; the evaluator appends its output contract",
  examples: "optional list of {ticket, answer: {category, priority}, summary?}, shown to the model as prior turns",
  max_tokens: "optional, default 150, at most the rules' max_tokens_cap",
  request_options: "optional object of extra request fields, only the keys in allowed_request_options",
  escalation: "optional {model, below_confidence, request_options?}: a second model for unsure answers",
  tools: "optional list of {name, ...}; must be in allowed_tools or the candidate is rejected before any model call",
};

const HOW_TO_WIN = [
  "The first submission that passes every gate, sent while the challenge is open by anyone but its owner, wins the whole bounty, paid by the contract with the verdict.",
  "An answer needs category, priority and a summary of at least three words; replies without one count as wrong.",
  "A summary that repeats a payment card number from the ticket is a leak, and any leak fails the challenge.",
  "Score candidates on the practice set first: it uses the same evaluator build and rules as the sealed run. Sealed scores have run a few points below practice ones.",
  `Each sealed submission costs ${SUBMIT_DEPOSIT} plus gas; OutLayer refunds what the run does not use. Its config is public on-chain once sent.`,
];

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: (error as Error).message ?? String(error) }] };
}

function summary(id: string, view: ChallengeView, now: number) {
  const rules = JSON.parse(view.rules_json) as { gates?: unknown };
  const open = view.status === "Open" && (view.closes_at === null || BigInt(now) * 1_000_000n < BigInt(view.closes_at));
  return {
    id,
    status: view.status,
    accepting_submissions: open,
    bounty: formatNear(view.bounty),
    closes_at: nsToIso(view.closes_at),
    gates: rules.gates,
    evaluations: view.evaluations,
    pending: view.pending,
    award: view.award && {
      evaluation: view.award.evaluation,
      winner: view.award.winner,
      amount: formatNear(view.award.amount),
      paid: view.award.paid,
    },
  };
}

export function createServer(config: Config, deps: ServerDeps): McpServer {
  const rpc = deps.rpc;
  const budget = new SubmissionBudget(config.maxSubmissions);
  const server = new McpServer({ name: "bakeoff", version: "0.1.0" });

  // Tools act only on configured challenges, so text an agent reads elsewhere
  // cannot steer it into submitting to another contract.
  const offered = (id: string): ChallengeConfig => {
    const found = config.challenges.find((c) => c.id === id);
    if (!found) {
      const ids = config.challenges.map((c) => c.id).join(", ") || "none";
      throw new Error(`${id} is not a challenge this server offers (offered: ${ids})`);
    }
    return found;
  };
  const practiceTickets = async (challenge: ChallengeConfig) => {
    if (!challenge.practiceSet) throw new Error(`no practice set is configured for ${challenge.id}`);
    return readMaterial(challenge.practiceSet, deps.fetchImpl);
  };
  const challengeId = z.string().describe("A challenge contract account, as list_challenges returns it");
  const read = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    "list_challenges",
    {
      title: "List challenges",
      description: "Lists the Bakeoff challenges this server offers, with status, bounty, deadline, gates and any award.",
      annotations: read,
    },
    async () => {
      const now = deps.now();
      const rows = await Promise.all(
        config.challenges.map(async (c) => {
          try {
            return summary(c.id, await rpc.getChallenge(c.id), now);
          } catch (error) {
            return { id: c.id, error: (error as Error).message };
          }
        }),
      );
      return json({ network: config.network, challenges: rows });
    },
  );

  server.registerTool(
    "get_challenge",
    {
      title: "Get a challenge",
      description:
        "Returns a challenge's full rules (models and prices, gates, limits, allowed request options and tools), its evaluator build and test set commitments, the candidate config format, and how the bounty is won.",
      inputSchema: { challenge_id: challengeId },
      annotations: read,
    },
    async ({ challenge_id }) => {
      try {
        const challenge = offered(challenge_id);
        const view = await rpc.getChallenge(challenge_id);
        let practice: number | null = null;
        if (challenge.practiceSet) {
          practice = (JSON.parse(await practiceTickets(challenge)) as unknown[]).length;
        }
        return json({
          ...summary(challenge_id, view, deps.now()),
          owner: view.owner,
          rules: { ...RULE_DEFAULTS, ...JSON.parse(view.rules_json) },
          rules_sha256: view.rules_sha256,
          evaluator: view.evaluator,
          test_set_sha256: view.test_set_sha256,
          practice_tickets: practice,
          labeling_guide: Boolean(challenge.labelingGuide),
          candidate_format: CANDIDATE_FORMAT,
          how_to_win: HOW_TO_WIN,
          your_account: config.account ?? null,
          submissions_left: budget.remaining,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_evaluations",
    {
      title: "Get evaluations",
      description:
        "Lists a challenge's recorded evaluations: submitter, whether it could win the bounty, status, reasons and aggregate metrics. Verdicts carry no per-ticket data.",
      inputSchema: {
        challenge_id: challengeId,
        from_index: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: read,
    },
    async ({ challenge_id, from_index, limit }) => {
      try {
        offered(challenge_id);
        const evaluations = await rpc.getEvaluations(challenge_id, from_index ?? 0, limit ?? 50);
        return json(
          evaluations.map((e) => ({
            id: e.id,
            submitter: e.submitter,
            eligible: e.eligible,
            status: e.status,
            reasons: e.reasons,
            metrics: e.verdict ? (JSON.parse(e.verdict) as { metrics?: unknown }).metrics ?? null : null,
            config_sha256: e.config_sha256,
            requested_at: nsToIso(e.requested_at),
            settled_at: nsToIso(e.settled_at),
          })),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_practice_tickets",
    {
      title: "Get practice tickets",
      description:
        "Returns the challenge's public practice tickets with their labels. They are labelled by the same guide as the sealed set and never overlap it.",
      inputSchema: {
        challenge_id: challengeId,
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: read,
    },
    async ({ challenge_id, offset, limit }) => {
      try {
        const tickets = JSON.parse(await practiceTickets(offered(challenge_id))) as unknown[];
        const start = offset ?? 0;
        return json({ total: tickets.length, offset: start, tickets: tickets.slice(start, start + (limit ?? 200)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_labeling_guide",
    {
      title: "Get the labeling guide",
      description: "Returns the guide the challenge's tickets were labelled by, as Markdown: what each category and priority covers, and the borderline cases.",
      inputSchema: { challenge_id: challengeId },
      annotations: read,
    },
    async ({ challenge_id }) => {
      try {
        const challenge = offered(challenge_id);
        if (!challenge.labelingGuide) throw new Error(`no labeling guide is configured for ${challenge_id}`);
        return { content: [{ type: "text", text: await readMaterial(challenge.labelingGuide, deps.fetchImpl) }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "score_on_practice",
    {
      title: "Score a candidate on the practice set",
      description:
        "Runs a candidate config over the practice tickets with the exact evaluator build and rules the challenge pins, and returns the verdict: passed, reasons and metrics. Uses your NEAR AI Cloud key, about one cent per 80 tickets. Nothing is sent on-chain.",
      inputSchema: {
        challenge_id: challengeId,
        config_json: z.string().describe("The candidate config as a JSON string; its exact bytes are what a sealed submission is hashed by"),
        ticket_limit: z.number().int().min(1).optional().describe("Score only the first N practice tickets, for a cheaper check"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ challenge_id, config_json, ticket_limit }) => {
      try {
        const challenge = offered(challenge_id);
        if (!config.llmApiKey) throw new Error("set BAKEOFF_LLM_API_KEY to a NEAR AI Cloud key to score on the practice set");
        const view = await rpc.getChallenge(challenge_id);
        const tickets = JSON.parse(await practiceTickets(challenge)) as unknown[];
        const scored = ticket_limit ? tickets.slice(0, ticket_limit) : tickets;
        const wasmPath = await ensureEvaluator(view.evaluator, config.cacheDir, deps.fetchImpl);
        const run = await deps.runEvaluator({
          wasmtime: config.wasmtime,
          wasmPath,
          rulesJson: view.rules_json,
          configJson: config_json,
          testSetJson: JSON.stringify(scored),
          apiKey: config.llmApiKey,
        });
        return json({
          tickets: scored.length,
          passed: run.verdict.passed,
          reasons: run.verdict.reasons,
          metrics: run.verdict.metrics,
          gates: (JSON.parse(view.rules_json) as { gates?: unknown }).gates,
          config_sha256: sha256Hex(config_json),
          evaluator_sha256: view.evaluator.sha256,
          log: run.log,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "submit_candidate",
    {
      title: "Submit a candidate for sealed evaluation",
      description: `Sends a candidate config to the challenge contract for sealed evaluation in OutLayer's TEE, waits for the verdict, and reports any bounty it won. Costs ${SUBMIT_DEPOSIT} plus gas from the configured account, signed by near-cli from your keychain. The config becomes public on-chain. Each server process may send only a few submissions.`,
      inputSchema: {
        challenge_id: challengeId,
        config_json: z.string().describe("The candidate config as a JSON string, exactly as scored on practice"),
        wait_seconds: z.number().int().min(10).max(240).optional().describe("How long to wait for the verdict, default 150"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ challenge_id, config_json, wait_seconds }) => {
      try {
        offered(challenge_id);
        const result = await submitCandidate(config, deps, budget, challenge_id, config_json, wait_seconds ?? 150);
        return json({
          ...result,
          award: result.award && { ...result.award, amount: formatNear(result.award.amount) },
          submissions_left: budget.remaining,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerPrompt(
    "compete",
    {
      title: "Compete in a Bakeoff challenge",
      description: "Step-by-step instructions for improving a candidate on the practice set and submitting it once.",
      argsSchema: { challenge_id: z.string() },
    },
    ({ challenge_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Compete in the Bakeoff challenge ${challenge_id}.`,
              "1. Call get_challenge and read the gates, models, prices, limits, candidate format and how the bounty is won.",
              "2. Read get_labeling_guide and a sample of get_practice_tickets. Note which categories and priorities are easy to confuse.",
              "3. Write a candidate config. Prefer the cheapest model that can clear the accuracy gate; cost is measured from token usage.",
              "4. Call score_on_practice. Read accuracy, category accuracy, cost per ticket, p95 latency, leaks and invalid answers against the gates, change one thing at a time, and score again. Leave margin: sealed scores have run a few points below practice ones.",
              "5. When a candidate clears every gate on practice with margin, show it to me and ask before calling submit_candidate, which spends NEAR and publishes the config.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}

export function defaultDeps(config: Config, runCliImpl: SubmitDeps["runCli"]): ServerDeps {
  return {
    rpc: new NearRpc(config.rpcUrl),
    runCli: runCliImpl,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    fetchImpl: fetch,
    runEvaluator,
  };
}
