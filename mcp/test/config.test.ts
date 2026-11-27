import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, resolveConfig } from "../src/config.ts";
import { CHALLENGE_CODE_HASHES } from "../src/registry.ts";

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
const BAKEOFF_BUILD = CHALLENGE_CODE_HASHES[2]!;
type Entry = { challenge: string; owner: string; practice_set?: string | null; labeling_guide?: string | null };

/**
 * The board at board.example and testnet's RPC: the listing registry answers `get_listings` with
 * `entries`, and `view_account` gives each account's code hash from `hashes`. `calls` records what
 * the RPC was asked.
 */
function network(entries: Entry[] = [], hashes: Record<string, string> = {}, opts: { boardUp?: boolean; rpcUp?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url === "https://board.example/challenges.json") {
      if (opts.boardUp === false) throw new TypeError("fetch failed");
      return Response.json(board);
    }
    assert.equal(url, "https://test.rpc.fastnear.com");
    if (opts.rpcUp === false) return new Response("unavailable", { status: 503 });
    const { params } = JSON.parse(String(init?.body)) as { params: { request_type: string; account_id: string; args_base64?: string } };
    calls.push(`${params.request_type} ${params.account_id}`);
    if (params.request_type === "view_account") {
      const hash = hashes[params.account_id];
      return Response.json(hash ? { result: { code_hash: hash, global_contract_hash: null } } : { error: { cause: { name: "UNKNOWN_ACCOUNT" } } });
    }
    const { from_index, limit } = JSON.parse(Buffer.from(params.args_base64!, "base64").toString()) as { from_index: number; limit: number };
    const page = entries.slice(from_index, from_index + limit).map((e) => ({
      challenge: e.challenge, owner: e.owner, updated_at_ms: 1,
      listing: { title: e.challenge, practice_set: e.practice_set ?? null, labeling_guide: e.labeling_guide ?? null },
    }));
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(page))] } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const boardFetch = network().fetchImpl;
const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;

test("with no config file, the board's list for the network is served, its files as board URLs", async () => {
  const config = await resolveConfig({ BAKEOFF_BOARD_URL: "https://board.example/" }, boardFetch);
  assert.deepEqual(config.challenges, [
    { id: "a.testnet", practiceSet: "https://board.example/data/practice.json", labelingGuide: "https://board.example/data/labeling-guide.md" },
    { id: "b.testnet", practiceSet: undefined, labelingGuide: undefined },
  ]);
  assert.equal(config.source, "https://board.example/challenges.json and the listing registry registry.finishr.testnet");
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

test("self-listed challenges join the board's, after it, and only accounts running a Bakeoff build count", async () => {
  const guide = "https://kiln.example/guide.md";
  const { fetchImpl } = network([
    { challenge: "x.owner.testnet", owner: "owner.testnet", practice_set: "https://kiln.example/practice.json", labeling_guide: guide },
    { challenge: "y.owner.testnet", owner: "owner.testnet" },
    { challenge: "a.testnet", owner: "testnet", practice_set: "https://elsewhere.example/p.json" },
  ], { "x.owner.testnet": BAKEOFF_BUILD, "y.owner.testnet": "11111111111111111111111111111111", "a.testnet": BAKEOFF_BUILD });
  const config = await resolveConfig({ BAKEOFF_BOARD_URL: "https://board.example" }, fetchImpl);
  assert.deepEqual(config.challenges, [
    { id: "a.testnet", practiceSet: "https://board.example/data/practice.json", labelingGuide: "https://board.example/data/labeling-guide.md" },
    { id: "b.testnet", practiceSet: undefined, labelingGuide: undefined },
    { id: "x.owner.testnet", practiceSet: "https://kiln.example/practice.json", labelingGuide: guide, listedBy: "owner.testnet" },
  ]);
});

test("a registry can name only https material, never a file on this machine", async () => {
  const { fetchImpl } = network([{ challenge: "x.owner.testnet", owner: "owner.testnet", practice_set: "/home/me/.ssh/id_ed25519", labeling_guide: "file:///etc/passwd" }], { "x.owner.testnet": BAKEOFF_BUILD });
  const config = await resolveConfig({ BAKEOFF_BOARD_URL: "https://board.example", BAKEOFF_LISTING_REGISTRY: "other.testnet" }, fetchImpl);
  assert.deepEqual(config.challenges.at(-1), { id: "x.owner.testnet", practiceSet: undefined, labelingGuide: undefined, listedBy: "owner.testnet" });
  assert.match(config.source, /listing registry other\.testnet$/);
});

test("a registry that cannot be read leaves the board's list, and an empty BAKEOFF_LISTING_REGISTRY turns it off", async () => {
  const unreadable = await resolveConfig({ BAKEOFF_BOARD_URL: "https://board.example" }, network([], {}, { rpcUp: false }).fetchImpl);
  assert.deepEqual(unreadable.challenges.map((c) => c.id), ["a.testnet", "b.testnet"]);
  assert.equal(unreadable.source, "https://board.example/challenges.json");
  const off = network([{ challenge: "x.owner.testnet", owner: "owner.testnet" }], { "x.owner.testnet": BAKEOFF_BUILD });
  const config = await resolveConfig({ BAKEOFF_BOARD_URL: "https://board.example", BAKEOFF_LISTING_REGISTRY: "" }, off.fetchImpl);
  assert.deepEqual(config.challenges.map((c) => c.id), ["a.testnet", "b.testnet"]);
  assert.deepEqual(off.calls, []);
});

test("mainnet has no registry yet, so only the board's list is read", async () => {
  const { fetchImpl, calls } = network();
  const config = await resolveConfig({ BAKEOFF_BOARD_URL: "https://board.example", BAKEOFF_NETWORK: "mainnet" }, fetchImpl);
  assert.equal(config.listingRegistry, undefined);
  assert.deepEqual(config.challenges.map((c) => c.id), ["c.near"]);
  assert.deepEqual(calls, []);
});

test("with the board down, a named self-listed challenge keeps its practice set", async () => {
  const { fetchImpl } = network([{ challenge: "x.owner.testnet", owner: "owner.testnet", practice_set: "https://kiln.example/practice.json" }], { "x.owner.testnet": BAKEOFF_BUILD }, { boardUp: false });
  const config = await resolveConfig({ BAKEOFF_BOARD_URL: "https://board.example", BAKEOFF_CHALLENGES: "x.owner.testnet,a.testnet" }, fetchImpl);
  assert.deepEqual(config.challenges, [
    { id: "x.owner.testnet", practiceSet: "https://kiln.example/practice.json", labelingGuide: undefined, listedBy: "owner.testnet" },
    { id: "a.testnet" },
  ]);
});
