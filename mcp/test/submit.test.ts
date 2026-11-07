import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/evaluator.ts";
import { SubmissionBudget, submitCandidate } from "../src/submit.ts";
import { CHALLENGE, challengeView, config, evaluation, FakeChain, FakeCli, FakeClock, NOW } from "./fakes.ts";

const CANDIDATE = '{"version":1,"model":"z-ai/glm-5.3-flash","system_prompt":"Triage."}';
const SHA = sha256Hex(CANDIDATE);
const VERDICT = JSON.stringify({ passed: true, reasons: [], metrics: { accuracy_bp: 9300, cost_per_ticket_uusd: 72 } });

function setup() {
  const chain = new FakeChain();
  const cli = new FakeCli();
  const clock = new FakeClock();
  const deps = { rpc: chain.asRpc(), runCli: cli.run, sleep: clock.sleep, now: clock.now };
  return { chain, cli, clock, deps };
}

test("a passing submission reports its verdict and the award it won", async () => {
  const { chain, cli, deps } = setup();
  const award = { evaluation: 3, winner: "agent.testnet", amount: "1000000000000000000000000", paid: true, in_flight: false };
  chain.challenges = [challengeView({ evaluations: 3 }), challengeView({ status: "Awarded", award })];
  chain.evaluationPages = [
    [],
    [evaluation({ id: 3, config_sha256: SHA })],
    [evaluation({ id: 3, config_sha256: SHA, status: "Passed", verdict: VERDICT })],
  ];

  const result = await submitCandidate(config(), deps, new SubmissionBudget(3), CHALLENGE, CANDIDATE, 150);

  assert.equal(result.status, "Passed");
  assert.equal(result.evaluation_id, 3);
  assert.equal(result.transaction, "7xTxHash");
  assert.deepEqual(result.metrics, { accuracy_bp: 9300, cost_per_ticket_uusd: 72 });
  assert.equal(result.award?.won_by_this_submission, true);
  assert.equal(result.config_sha256, SHA);
  // Polling starts at the id the challenge would assign next.
  assert.ok(chain.calls.includes(`get_evaluations ${CHALLENGE} 3 20`));
});

test("near-cli is run without a shell, with the contract's deposit and keychain signing", async () => {
  const { chain, cli, deps } = setup();
  chain.evaluationPages = [[evaluation({ config_sha256: SHA, status: "Failed", reasons: ["gate_cost"] })]];
  await submitCandidate(config(), deps, new SubmissionBudget(3), CHALLENGE, CANDIDATE, 150);

  const [call] = cli.invocations;
  assert.equal(call?.command, "near");
  assert.deepEqual(call?.args, [
    "contract", "call-function", "as-transaction", CHALLENGE, "submit",
    "json-args", JSON.stringify({ config_json: CANDIDATE }),
    "prepaid-gas", "300.0 Tgas", "attached-deposit", "0.035 NEAR",
    "sign-as", "agent.testnet", "network-config", "testnet", "sign-with-keychain", "send",
  ]);
});

test("another submitter's evaluation in the same range is not mistaken for ours", async () => {
  const { chain, deps } = setup();
  chain.evaluationPages = [[
    evaluation({ id: 0, submitter: "rival.testnet", config_sha256: SHA, status: "Passed", verdict: VERDICT }),
    evaluation({ id: 1, config_sha256: "f".repeat(64), status: "Passed", verdict: VERDICT }),
    evaluation({ id: 2, config_sha256: SHA, status: "Failed", reasons: ["gate_accuracy"] }),
  ]];
  const result = await submitCandidate(config(), deps, new SubmissionBudget(3), CHALLENGE, CANDIDATE, 150);
  assert.equal(result.evaluation_id, 2);
  assert.equal(result.status, "Failed");
  assert.deepEqual(result.reasons, ["gate_accuracy"]);
});

test("an RPC timeout is expected and the contract is polled", async () => {
  const { chain, cli, deps } = setup();
  cli.result = { code: 1, output: "\u001b[91mJSON RPC server responded with an unexpected status code: 408 Request Timeout\u001b[0m" };
  chain.evaluationPages = [[evaluation({ config_sha256: SHA, status: "Failed", reasons: ["gate_cost"] })]];
  const result = await submitCandidate(config(), deps, new SubmissionBudget(3), CHALLENGE, CANDIDATE, 150);
  assert.equal(result.status, "Failed");
  assert.equal(result.transaction, null);
});

test("any other near-cli failure is reported at once", async () => {
  const { cli, chain, deps } = setup();
  cli.result = { code: 1, output: "Error: Account <agent.testnet> does not have enough balance (0.3 NEAR) to cover TX cost\n" };
  await assert.rejects(
    submitCandidate(config(), deps, new SubmissionBudget(3), CHALLENGE, CANDIDATE, 150),
    /not sent: Error: Account <agent.testnet> does not have enough balance/,
  );
  assert.ok(!chain.calls.some((c) => c.startsWith("get_evaluations")));
});

test("a verdict that does not arrive in time is returned as pending", async () => {
  const { chain, clock, deps } = setup();
  chain.evaluationPages = [[evaluation({ id: 5, config_sha256: SHA })]];
  const result = await submitCandidate(config(), deps, new SubmissionBudget(3), CHALLENGE, CANDIDATE, 30);
  assert.equal(result.status, "Pending");
  assert.match(result.note ?? "", /evaluation 5/);
  assert.ok(clock.ms - NOW >= 30_000);
});

test("a sent transaction with no recorded evaluation is reported, not waited on forever", async () => {
  const { deps } = setup();
  const result = await submitCandidate(config(), deps, new SubmissionBudget(3), CHALLENGE, CANDIDATE, 240);
  assert.equal(result.status, "NotRecorded");
});

test("submissions are refused when the challenge cannot take them", async () => {
  const cases: [Partial<Parameters<typeof challengeView>[0]>, RegExp][] = [
    [{ status: "Draft" }, /still a draft/],
    [{ status: "Awarded" }, /awarded and takes no more submissions/],
    [{ status: "Closed" }, /closed and takes no more submissions/],
    [{ closes_at: String(BigInt(NOW) * 1_000_000n) }, /deadline .* has passed/],
  ];
  for (const [overrides, message] of cases) {
    const { chain, cli, deps } = setup();
    chain.challenges = [challengeView(overrides)];
    await assert.rejects(submitCandidate(config(), deps, new SubmissionBudget(3), CHALLENGE, CANDIDATE, 150), message);
    assert.equal(cli.invocations.length, 0);
  }
});

test("the owner may send trial runs to a draft", async () => {
  const { chain, deps } = setup();
  chain.challenges = [challengeView({ status: "Draft", closes_at: null })];
  chain.evaluationPages = [[evaluation({ submitter: "sponsor.testnet", config_sha256: SHA, eligible: false, status: "Failed", reasons: ["gate_cost"] })]];
  const result = await submitCandidate(config({ account: "sponsor.testnet" }), deps, new SubmissionBudget(3), CHALLENGE, CANDIDATE, 150);
  assert.equal(result.eligible, false);
});

test("the submission budget caps how many transactions a server sends", async () => {
  const { chain, cli, deps } = setup();
  chain.evaluationPages = [[evaluation({ config_sha256: SHA, status: "Failed" })]];
  const budget = new SubmissionBudget(1);
  await submitCandidate(config(), deps, budget, CHALLENGE, CANDIDATE, 150);
  await assert.rejects(submitCandidate(config(), deps, budget, CHALLENGE, CANDIDATE, 150), /sent its 1 allowed submissions/);
  assert.equal(cli.invocations.length, 1);
});

test("a submission needs an account and valid JSON", async () => {
  const { deps } = setup();
  await assert.rejects(submitCandidate(config({ account: undefined }), deps, new SubmissionBudget(3), CHALLENGE, CANDIDATE, 150), /BAKEOFF_ACCOUNT/);
  await assert.rejects(submitCandidate(config(), deps, new SubmissionBudget(3), CHALLENGE, "{not json", 150), /not valid JSON/);
});
