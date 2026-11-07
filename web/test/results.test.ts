import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/lib/near.ts";
import { chatRequest, checkRequirements, compareWithBaseline, findSubmission, summariseConfig } from "../src/lib/results.ts";

const CONFIG = '{"version":1,"model":"small","system_prompt":"Triage. ","max_tokens":70,"request_options":{"reasoning_effort":"low","temperature":1}}';

function fakeChain(config: string) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes("nearblocks")) {
      return Response.json({
        data: [
          { transaction_hash: "OPEN", signer_account_id: "owner.near", actions: [{ method: "open" }] },
          { transaction_hash: "OTHER", signer_account_id: "someone.near", actions: [{ method: "submit" }] },
          { transaction_hash: "MINE", signer_account_id: "agent.near", actions: [{ method: "submit" }] },
        ],
      });
    }
    const { params } = JSON.parse(String(init?.body)) as { params: { tx_hash: string } };
    const args = btoa(JSON.stringify({ config_json: params.tx_hash === "MINE" ? config : "{}" }));
    return Response.json({ result: { transaction: { actions: [{ FunctionCall: { method_name: "submit", args } }] } } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("a result's config is found from its transaction and accepted only if it hashes to the record", async () => {
  const sha = await sha256Hex(CONFIG);
  const chain = fakeChain(CONFIG);
  const found = await findSubmission("mainnet", "c1.near", "agent.near", sha, chain.fetchImpl);
  assert.deepEqual(found, { config: CONFIG, transaction: "MINE" });
  // Only the submitter's own submit transactions are fetched.
  assert.equal(chain.calls.filter((u) => u.includes("archival")).length, 1);

  const tampered = fakeChain(CONFIG.replace("70", "71"));
  assert.equal(await findSubmission("mainnet", "c2.near", "agent.near", sha, tampered.fetchImpl), null);
});

test("the chat request matches the evaluator's: contract appended, its fields win over options", () => {
  const rules = JSON.stringify({ endpoint: "x", categories: ["billing", "other"], priorities: ["low", "high"], temperature: 0 });
  const withExample = JSON.stringify({ ...JSON.parse(CONFIG), examples: [{ ticket: "Charged twice", answer: { category: "billing", priority: "high" }, summary: "Double charge." }] });
  const request = chatRequest(rules, withExample, "Where is my parcel?");
  assert.equal(request.model, "small");
  assert.equal(request.max_tokens, 70);
  assert.equal(request.temperature, 0);
  assert.equal(request.reasoning_effort, "low");
  const messages = request.messages as { role: string; content: string }[];
  assert.equal(messages[0]!.content, 'Triage.\n\nRespond with only a JSON object with these keys: "category" (one of: billing, other), "priority" (one of: low, high), "confidence" (a number from 0 to 1) and "summary" (one sentence for the support agent). An answer without a summary counts as wrong.');
  assert.deepEqual(messages.slice(1), [
    { role: "user", content: "Charged twice" },
    { role: "assistant", content: '{"category":"billing","priority":"high","confidence":1,"summary":"Double charge."}' },
    { role: "user", content: "Where is my parcel?" },
  ]);
  // Without a temperature in the rules, none is sent, whatever the options say.
  const noTemperature = chatRequest(JSON.stringify({ ...JSON.parse(rules), temperature: null }), CONFIG, "t");
  assert.equal("temperature" in noTemperature, false);
  assert.equal(summariseConfig('{"version":1,"model":"m","system_prompt":"p"}').maxTokens, 150);
});

test("requirements and the baseline comparison read the way a team would", () => {
  const format = { percent: (bp?: number) => (bp === undefined ? "–" : `${(bp / 100).toFixed(1)}%`), micro: (u?: number) => `${u} µ$`, seconds: (ms?: number) => `${((ms ?? 0) / 1000).toFixed(1)} s` };
  const gates = { min_accuracy_bp: 8500, max_cost_per_ticket_uusd: 96, max_p95_latency_ms: 18159, max_leaks: 0 };
  const baseline = { accuracy_bp: 8700, cost_per_ticket_uusd: 128, p95_latency_ms: 18159 };
  const winner = { accuracy_bp: 8900, cost_per_ticket_uusd: 51, p95_latency_ms: 2574, leaks: 0 };
  assert.deepEqual(checkRequirements(gates, winner, baseline, format).map((r) => r.met), [true, true, true, true]);
  assert.deepEqual(checkRequirements(gates, { ...winner, cost_per_ticket_uusd: 126 }, baseline, format).map((r) => r.met), [true, false, true, true]);
  assert.deepEqual(checkRequirements(gates, null, baseline, format).map((r) => r.met), [null, null, null, null]);
  assert.deepEqual(compareWithBaseline(winner, baseline).map((c) => c.text), ["+2.0 points", "60% cheaper", "86% faster"]);
  assert.deepEqual(compareWithBaseline({ ...winner, accuracy_bp: 8500, cost_per_ticket_uusd: 140 }, baseline).map((c) => c.text), ["−2.0 points", "9% dearer", "86% faster"]);
});
