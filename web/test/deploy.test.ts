import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { codeHash, CONTRACT, deploymentRecord, deploySharedTransaction, deployTransaction, EVALUATOR, initArgs, loadContract, SHARED_CONTRACT, sharedStorageDeposit, storageDeposit, testSetSha256 } from "../src/lib/deploy.ts";
import { emptyDraft, json, rulesOf } from "../src/lib/setup.ts";
import { commitLink, parseSnapshot, sourceOf } from "../src/lib/source.ts";

const repo = (path: string) => new URL(`../../${path}`, import.meta.url);
const code = new Uint8Array(readFileSync(new URL("../public/contract/bakeoff_contract.wasm", import.meta.url)));
const draft = { ...emptyDraft("testnet", "kettle.testnet", new Date("2026-11-17")), baseline: { accuracy: "87", cost: "128", p95: "18.159" } };
const rulesJson = json(rulesOf(draft));
const input = { network: "testnet" as const, owner: "kettle.testnet", challenge: "challenge-triage.kettle.testnet", rulesJson, testSetSha256: "1b1730710c80057615229d18513308fc0fa3130b8ac281da54d399522ef5b17a" };

test("the contract the board serves is the build the newest testnet challenges run", async () => {
  assert.equal(code.length, CONTRACT.bytes);
  // NEAR reports this code hash for challenge-20261113142333.finishr.testnet and its siblings.
  assert.equal(await codeHash(code), "HeXPDJmQgPDfBfYvedbTL3iVyFvX7yZ84NH3s5n3tTGU");
  assert.equal(await codeHash(code), CONTRACT.codeHash);
});

test("the board refuses to deploy a contract that is not the pinned build", async () => {
  const served = (bytes: Uint8Array<ArrayBuffer>) => (async () => new Response(bytes)) as typeof fetch;
  assert.equal((await loadContract(served(code), "/")).length, CONTRACT.bytes);
  const tampered = code.slice();
  tampered[1000] = tampered[1000]! ^ 1;
  await assert.rejects(loadContract(served(tampered), "/"), /not the pinned/);
});

test("one transaction creates, funds, deploys and initialises the challenge, and adds no key", () => {
  const tx = deployTransaction(input, code);
  assert.equal(tx.receiverId, "challenge-triage.kettle.testnet");
  assert.deepEqual(tx.actions.map((a) => a.type), ["CreateAccount", "Transfer", "DeployContract", "FunctionCall"]);
  assert.ok(!tx.actions.some((a) => (a.type as string) === "AddKey"), "a locked challenge has no access key");
  const call = tx.actions[3]!;
  assert.equal(call.type === "FunctionCall" && call.params.methodName, "new");
  assert.deepEqual(call.type === "FunctionCall" && call.params.args, initArgs(input));
});

test("new gets what deploy.sh gives it: the owner, OutLayer, the evaluator, the secrets and the rules", () => {
  assert.deepEqual(initArgs(input), {
    owner: "kettle.testnet",
    outlayer: "outlayer.testnet",
    evaluator: EVALUATOR.testnet,
    secrets: { profile: "bakeoff", owner: "kettle.testnet" },
    rules_json: rulesJson,
    test_set_sha256: input.testSetSha256,
  });
  assert.equal((initArgs({ ...input, network: "mainnet" }) as { outlayer: string }).outlayer, "outlayer.near");
  assert.equal(EVALUATOR.testnet.sha256, EVALUATOR.mainnet.sha256);
});

test("the challenge is sent what it stores, about 1.9 NEAR, rounded up to 0.01", () => {
  const deposit = storageDeposit(code.length, rulesJson);
  const near = Number(deposit) / 1e24;
  assert.ok(near > 1.88 && near < 1.95, `got ${near}`);
  assert.equal(deposit % 10n ** 22n, 0n);
});

test("the test set is hashed as deploy.sh hashes it", async () => {
  // Python's text mode, then rstrip("\n"), as in scripts/near/deploy.sh and store-secrets.sh.
  const sample = readFileSync(repo("data/tickets/sealed-sample.json"), "utf8");
  assert.equal(await testSetSha256(sample), "1b1730710c80057615229d18513308fc0fa3130b8ac281da54d399522ef5b17a");
  const lf = "7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78"; // sha256("a\nb")
  assert.equal(await testSetSha256("a\nb\n\n"), lf);
  assert.equal(await testSetSha256("a\r\nb\r\n"), lf);
});

test("the deployment record has every key the scripts load", () => {
  const record = deploymentRecord(input, { rules: "rules.json", testSet: "data/private/sealed.json" });
  const keys = record.split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => l.split("=")[0]);
  // The keys scripts/near/deploy.sh writes to .deploy/<network>.env, as KEY=$KEY lines.
  const written = [...readFileSync(repo("scripts/near/deploy.sh"), "utf8").matchAll(/^([A-Z_0-9]+)=\$\1$/gm)].map((m) => m[1]);
  assert.equal(written.length, 8);
  for (const key of written) assert.ok(keys.includes(key!), `missing ${key}`);
  assert.match(record, /^CHALLENGE=challenge-triage\.kettle\.testnet$/m);
  assert.match(record, /^TEST_SET_SHA256=1b1730710c/m);
});

test("on the shared contract, one transaction uses the published code by hash and adds no key", () => {
  const tx = deploySharedTransaction(input, CONTRACT.codeHash);
  assert.deepEqual(tx.actions.map((a) => a.type), ["CreateAccount", "Transfer", "UseGlobalContract", "FunctionCall"]);
  const use = tx.actions[2]!;
  assert.deepEqual(use.type === "UseGlobalContract" && use.params, { contractIdentifier: { codeHash: "HeXPDJmQgPDfBfYvedbTL3iVyFvX7yZ84NH3s5n3tTGU" } });
  const call = tx.actions[3]!;
  assert.deepEqual(call.type === "FunctionCall" && call.params.args, initArgs(input));
  assert.ok(!tx.actions.some((a) => (a.type as string) === "AddKey" || a.type === "DeployContract"));
});

test("a challenge on the shared contract is sent what the sandbox proved enough, about 0.06 NEAR", () => {
  // The same formula as shared_storage_deposit in integration-tests/tests/shared_contract.rs,
  // which creates a challenge on the shared code with it on a local node.
  const rules = readFileSync(repo("examples/rules/local.json"), "utf8");
  const bytes = BigInt(new TextEncoder().encode(rules).length) + 4_000n + 200n;
  const cent = 10n ** 22n;
  assert.equal(sharedStorageDeposit(rules), ((bytes * 10n ** 19n + cent - 1n) / cent) * cent);
  const near = Number(sharedStorageDeposit(rulesJson)) / 1e24;
  assert.ok(near > 0.04 && near < 0.08, `got ${near}`);
  assert.ok(sharedStorageDeposit(rulesJson) * 30n < storageDeposit(CONTRACT.bytes, rulesJson));
});

test("the shared contract published on testnet is the build the board serves", () => {
  assert.equal(SHARED_CONTRACT.testnet, CONTRACT.codeHash);
  assert.equal(SHARED_CONTRACT.mainnet, undefined);
});

test("a reproducible build's metadata names its commit", () => {
  const rev = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(parseSnapshot(`git+https://github.com/successaje/bakeoff?rev=${rev}`), { repository: "https://github.com/successaje/bakeoff", commit: rev });
  assert.equal(parseSnapshot("git+https://github.com/successaje/bakeoff?rev=main"), null);
  const source = sourceOf("Hash111", {
    version: "0.1.0",
    build_info: { build_environment: "sourcescan/cargo-near:0.22.0-rust-1.99.1@sha256:c965", build_command: ["cargo", "near", "build"], source_code_snapshot: `git+https://github.com/successaje/bakeoff?rev=${rev}`, contract_path: "contract" },
  });
  assert.equal(source.build?.commit, rev);
  assert.equal(commitLink(source.build!), `https://github.com/successaje/bakeoff/tree/${rev}/contract`);
  // Contracts built before reproducible builds report no build_info.
  assert.equal(sourceOf("Hash111", { version: "0.1.0", link: "https://github.com/successaje/bakeoff", build_info: null }).build, null);
  assert.equal(sourceOf("Hash111", null).build, null);
});
