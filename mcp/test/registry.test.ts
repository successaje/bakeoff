import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHALLENGE_CODE_HASHES, KNOWN_EVALUATORS, LISTING_REGISTRY, practiceRunRefusal } from "../src/registry.ts";
import { challengeView, RULES } from "./fakes.ts";

const board = (path: string) => readFileSync(new URL(`../../web/src/lib/${path}`, import.meta.url), "utf8");

test("the registry, challenge builds and evaluator builds are the ones the board uses", () => {
  const registry = board("registry.ts");
  const hashes = registry.slice(registry.indexOf("CHALLENGE_CODE_HASHES"), registry.indexOf("];", registry.indexOf("CHALLENGE_CODE_HASHES")));
  assert.deepEqual([...hashes.matchAll(/"(\w{43,44})"/g)].map((m) => m[1]), CHALLENGE_CODE_HASHES);
  const registries = registry.slice(registry.indexOf("LISTING_REGISTRY"), registry.indexOf("};", registry.indexOf("LISTING_REGISTRY")));
  assert.deepEqual(Object.fromEntries([...registries.matchAll(/(testnet|mainnet): "([^"]+)"/g)].map((m) => [m[1], m[2]])), LISTING_REGISTRY);
  const pinned = [...board("deploy.ts").matchAll(/sha256: "([0-9a-f]{64})"/g)].map((m) => m[1]);
  assert.ok(pinned.length >= 2);
  for (const sha of pinned) assert.ok(KNOWN_EVALUATORS.includes(sha!), `the board deploys evaluator ${sha}`);
});

const selfListed = { id: "x.owner.testnet", listedBy: "owner.testnet" };
const known = { url: "https://fastfs.example/e.wasm", sha256: KNOWN_EVALUATORS[0]! };

test("a self-listed challenge is practised with your key only on a Bakeoff evaluator calling NEAR AI Cloud", () => {
  assert.equal(practiceRunRefusal(selfListed, challengeView({ evaluator: known })), null);
  const attested = JSON.stringify({ ...RULES, endpoint: "https://cloud-api.near.ai/v1/chat/completions", model_attestation: "near-ai-cloud" });
  assert.equal(practiceRunRefusal(selfListed, challengeView({ evaluator: known, rules_json: attested })), null);

  const ownBuild = challengeView({ evaluator: { url: "https://kiln.example/e.wasm", sha256: "f".repeat(64) } });
  assert.match(practiceRunRefusal(selfListed, ownBuild) ?? "", /pins evaluator f{64}, which is not a Bakeoff build/);

  for (const endpoint of ["https://cloud-api.near.ai.kiln.example/v1/chat/completions", "https://kiln.example/v1/chat/completions", "http://127.0.0.1:8787/v1/chat/completions"]) {
    const view = challengeView({ evaluator: known, rules_json: JSON.stringify({ ...RULES, endpoint }) });
    assert.match(practiceRunRefusal(selfListed, view) ?? "", /send model calls to .* not https:\/\/cloud-api\.near\.ai/, endpoint);
  }
  assert.match(practiceRunRefusal(selfListed, challengeView({ evaluator: known, rules_json: "{" })) ?? "", /an unreadable endpoint/);
});

test("challenges from the board or a config file are practised as before", () => {
  const ownBuild = challengeView({ evaluator: { url: "https://kiln.example/e.wasm", sha256: "f".repeat(64) }, rules_json: JSON.stringify({ ...RULES, endpoint: "http://127.0.0.1:8787/v1/chat/completions" }) });
  assert.equal(practiceRunRefusal({ id: "a.testnet" }, ownBuild), null);
});
