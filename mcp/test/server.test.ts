import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.ts";
import { type RunOptions, sha256Hex } from "../src/evaluator.ts";
import { createServer } from "../src/server.ts";
import { CHALLENGE, challengeView, config, FakeChain, FakeCli, FakeClock } from "./fakes.ts";

const WASM = new TextEncoder().encode("\0asm pinned build");

async function connect(overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bakeoff-mcp-"));
  const practice = join(dir, "practice.json");
  await writeFile(practice, JSON.stringify([
    { id: "p1", text: "Charged twice", label: { category: "billing", priority: "high" } },
    { id: "p2", text: "Where is it, no rush", label: { category: "shipping", priority: "low" } },
  ]));
  const chain = new FakeChain();
  chain.challenges = [challengeView({ evaluator: { url: "https://fastfs.example/e.wasm", sha256: sha256Hex(WASM) } })];
  const runs: RunOptions[] = [];
  const clock = new FakeClock();
  const server = createServer(
    config({ challenges: [{ id: CHALLENGE, practiceSet: practice }], cacheDir: join(dir, "cache"), ...overrides }),
    {
      rpc: chain.asRpc(),
      runCli: new FakeCli().run,
      sleep: clock.sleep,
      now: clock.now,
      fetchImpl: (() => Promise.resolve(new Response(WASM))) as unknown as typeof fetch,
      runEvaluator: (options) => {
        runs.push(options);
        return Promise.resolve({
          verdict: { passed: true, reasons: [], metrics: { accuracy_bp: 10000 }, rules_sha256: "", config_sha256: "", test_set_sha256: "" },
          log: [],
        });
      },
    },
  );
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    return { isError: Boolean(result.isError), text, json: () => JSON.parse(text) };
  };
  return { client, call, runs, chain };
}

test("the server offers the contributor workflow as tools and a prompt", async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name), [
    "list_challenges", "get_challenge", "get_evaluations", "get_practice_tickets",
    "get_labeling_guide", "score_on_practice", "submit_candidate",
  ]);
  assert.equal(tools.find((t) => t.name === "list_challenges")?.annotations?.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "submit_candidate")?.annotations?.readOnlyHint, false);
  const prompts = (await client.listPrompts()).prompts;
  assert.deepEqual(prompts.map((p) => p.name), ["compete"]);
});

test("challenges are summarised with the bounty and deadline people read", async () => {
  const { call } = await connect();
  const { challenges } = (await call("list_challenges")).json();
  assert.equal(challenges[0].bounty, "1 NEAR");
  assert.equal(challenges[0].accepting_submissions, true);
  assert.equal(challenges[0].gates.min_accuracy_bp, 8500);
});

test("get_challenge fills in the evaluator's defaults for limits the rules leave out", async () => {
  const { call } = await connect();
  const challenge = (await call("get_challenge", { challenge_id: CHALLENGE })).json();
  assert.equal(challenge.rules.max_examples, 8);
  assert.equal(challenge.rules.max_tokens_cap, 400);
  assert.equal(challenge.practice_tickets, 2);
  assert.equal(challenge.submissions_left, 3);
  assert.ok(challenge.how_to_win.length > 0);
});

test("only configured challenges are served", async () => {
  const { call } = await connect();
  for (const name of ["get_challenge", "get_evaluations", "get_practice_tickets", "score_on_practice", "submit_candidate"]) {
    const result = await call(name, { challenge_id: "elsewhere.testnet", config_json: "{}" });
    assert.ok(result.isError, name);
    assert.match(result.text, /not a challenge this server offers/);
  }
});

test("practice scoring runs the verified pinned build on the chosen tickets with the challenge's rules", async () => {
  const { call, runs } = await connect();
  const candidate = '{"version":1,"model":"z-ai/glm-5.3-flash","system_prompt":"Triage."}';
  const result = (await call("score_on_practice", { challenge_id: CHALLENGE, config_json: candidate, ticket_limit: 1 })).json();
  assert.equal(result.passed, true);
  assert.equal(result.tickets, 1);
  assert.equal(result.config_sha256, sha256Hex(candidate));
  assert.equal(runs.length, 1);
  assert.match(runs[0]!.wasmPath, new RegExp(`${sha256Hex(WASM)}\\.wasm$`));
  assert.equal(JSON.parse(runs[0]!.testSetJson).length, 1);
  assert.equal(runs[0]!.configJson, candidate);
  assert.equal(runs[0]!.apiKey, "test-key");
});

test("practice scoring needs the contributor's own model API key", async () => {
  const { call } = await connect({ llmApiKey: undefined });
  const result = await call("score_on_practice", { challenge_id: CHALLENGE, config_json: "{}" });
  assert.ok(result.isError);
  assert.match(result.text, /BAKEOFF_LLM_API_KEY/);
});
