import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, resolveConfig } from "../src/config.ts";

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

const board = {
  testnet: [
    { id: "a.testnet", practice_set: "data/practice.json", labeling_guide: "data/labeling-guide.md" },
    { id: "b.testnet" },
  ],
  mainnet: [{ id: "c.near", practice_set: "data/practice.json" }],
};
const boardFetch = (async (url: string) => {
  assert.equal(url, "https://board.example/challenges.json");
  return Response.json(board);
}) as typeof fetch;
const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;

test("with no config file, the board's list for the network is served, its files as board URLs", async () => {
  const config = await resolveConfig({ BAKEOFF_BOARD_URL: "https://board.example/" }, boardFetch);
  assert.deepEqual(config.challenges, [
    { id: "a.testnet", practiceSet: "https://board.example/data/practice.json", labelingGuide: "https://board.example/data/labeling-guide.md" },
    { id: "b.testnet", practiceSet: undefined, labelingGuide: undefined },
  ]);
  assert.equal(config.source, "https://board.example/challenges.json");
  const mainnet = await resolveConfig({ BAKEOFF_BOARD_URL: "https://board.example", BAKEOFF_NETWORK: "mainnet" }, boardFetch);
  assert.deepEqual(mainnet.challenges.map((c) => c.id), ["c.near"]);
});

test("BAKEOFF_CHALLENGES narrows the board's list and keeps each challenge's practice set", async () => {
  const config = await resolveConfig({ BAKEOFF_BOARD_URL: "https://board.example", BAKEOFF_CHALLENGES: "a.testnet,unlisted.testnet" }, boardFetch);
  assert.deepEqual(config.challenges.map((c) => [c.id, c.practiceSet]), [["a.testnet", "https://board.example/data/practice.json"], ["unlisted.testnet", undefined]]);
});

test("when the board cannot be read, named challenges still work and nothing named is a clear error", async () => {
  const config = await resolveConfig({ BAKEOFF_CHALLENGES: "a.testnet" }, down);
  assert.deepEqual(config.challenges, [{ id: "a.testnet" }]);
  assert.match(config.source, /could not be read: fetch failed/);
  await assert.rejects(resolveConfig({}, down), /could not read the board's list of challenges .* set BAKEOFF_MCP_CONFIG or BAKEOFF_CHALLENGES/);
});

test("a config file is used as it is, without asking the board", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakeoff-mcp-"));
  const file = join(dir, "bakeoff.json");
  await writeFile(file, JSON.stringify({ challenges: [{ id: "x.testnet" }] }));
  const config = await resolveConfig({ BAKEOFF_MCP_CONFIG: file }, down);
  assert.deepEqual(config.challenges.map((c) => c.id), ["x.testnet"]);
  assert.equal(config.source, file);
});
