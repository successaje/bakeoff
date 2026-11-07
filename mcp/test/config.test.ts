import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("paths in the config file are relative to it and the environment adds to it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakeoff-mcp-"));
  const file = join(dir, "bakeoff.json");
  await writeFile(file, JSON.stringify({
    network: "testnet",
    challenges: [{ id: "a.testnet", practice_set: "data/practice.json", labeling_guide: "https://example.com/guide.md" }],
  }));
  const config = loadConfig({ BAKEOFF_MCP_CONFIG: file, BAKEOFF_CHALLENGES: "b.testnet, a.testnet", BAKEOFF_ACCOUNT: "me.testnet" });
  assert.equal(config.rpcUrl, "https://test.rpc.fastnear.com");
  assert.deepEqual(config.challenges.map((c) => c.id), ["a.testnet", "b.testnet"]);
  assert.equal(config.challenges[0]?.practiceSet, join(dir, "data/practice.json"));
  assert.equal(config.challenges[0]?.labelingGuide, "https://example.com/guide.md");
  assert.equal(config.account, "me.testnet");
  assert.equal(config.maxSubmissions, 3);
  assert.equal(config.signWith, "keychain");
});

test("invalid settings are refused at start-up", () => {
  assert.throws(() => loadConfig({ BAKEOFF_NETWORK: "betanet" }), /testnet or mainnet/);
  assert.throws(() => loadConfig({ BAKEOFF_SIGN_WITH: "plaintext" }), /keychain or legacy-keychain/);
  assert.throws(() => loadConfig({ BAKEOFF_MAX_SUBMISSIONS: "many" }), /whole number/);
});
