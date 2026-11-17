import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHALLENGE_CODE_HASHES, type ListedChallenge, mergeListings, selfListedChallenges } from "../src/lib/registry.ts";
import { emptyDraft, listCommand, registryArgs } from "../src/lib/setup.ts";

const listing = (title: string) => ({
  title, sponsor: "Kettle & Kiln", summary: "Route each message.", problem: null, tags: ["Cost"], tickets: 100,
  baseline: { accuracy_bp: 8700, cost_per_ticket_uusd: 128, p95_latency_ms: 18159 },
  baseline_config_sha256: null, practice_set: "https://example.com/practice.json", labeling_guide: null,
});

function fakeRegistry(entries: { challenge: string; owner: string; title: string }[], codeHashes: Record<string, string>) {
  const calls: unknown[] = [];
  return {
    calls,
    rpc: {
      view: (async (_account: string, method: string, args?: { from_index: number; limit: number }) => {
        calls.push([method, args]);
        const page = entries.slice(args!.from_index, args!.from_index + args!.limit);
        return page.map((e) => ({ challenge: e.challenge, owner: e.owner, listing: listing(e.title), updated_at_ms: 1 }));
      }) as <T>(a: string, m: string, x?: object) => Promise<T>,
      codeHash: async (account: string) => {
        if (!(account in codeHashes)) throw new Error("UNKNOWN_ACCOUNT");
        return codeHashes[account]!;
      },
    },
  };
}

test("self-listed challenges are read a page at a time, and only accounts running a Bakeoff build are shown", async () => {
  const entries = Array.from({ length: 102 }, (_, i) => ({ challenge: `c${i}.owner.testnet`, owner: "owner.testnet", title: `Challenge ${i}` }));
  const hashes = Object.fromEntries(entries.map((e) => [e.challenge, CHALLENGE_CODE_HASHES[1]!]));
  hashes["c5.owner.testnet"] = "11111111111111111111111111111111"; // no contract
  delete hashes["c7.owner.testnet"]; // the account does not exist
  const { rpc, calls } = fakeRegistry(entries, hashes);
  const listed = await selfListedChallenges("registry.testnet", rpc);
  assert.deepEqual(calls.map((c) => (c as [string, { from_index: number }])[1].from_index), [0, 100]);
  assert.equal(listed.length, 100);
  assert.ok(!listed.some((c) => c.id === "c5.owner.testnet" || c.id === "c7.owner.testnet"));
  assert.deepEqual(listed[0], {
    id: "c0.owner.testnet", title: "Challenge 0", sponsor: "Kettle & Kiln", summary: "Route each message.", tickets: 100,
    baseline: { accuracy_bp: 8700, cost_per_ticket_uusd: 128, p95_latency_ms: 18159 },
    tags: ["Cost"], practice_set: "https://example.com/practice.json", self_listed: true, listed_by: "owner.testnet",
  });
});

test("challenges.json wins when it lists a challenge that is also self-listed", () => {
  const curated = [{ id: "a.testnet", title: "Curated" }] as ListedChallenge[];
  const selfListed = [{ id: "a.testnet", title: "Self" }, { id: "b.testnet", title: "Self B" }] as ListedChallenge[];
  assert.deepEqual(mergeListings(curated, selfListed).map((c) => c.title), ["Curated", "Self B"]);
});

test("the setup form's list arguments have exactly the registry contract's fields", () => {
  const draft = { ...emptyDraft("testnet", "kettle.testnet", new Date("2026-11-17")), title: "Triage", sponsor: "Kettle & Kiln", summary: "Route.", baseline: { accuracy: "87", cost: "128", p95: "18.159" }, practiceSet: "https://example.com/p.json" };
  const args = registryArgs(draft) as { challenge: string; listing: Record<string, unknown> };
  // The field names of `pub struct Listing` in registry/src/lib.rs.
  const source = readFileSync(new URL("../../registry/src/lib.rs", import.meta.url), "utf8");
  const struct = source.slice(source.indexOf("pub struct Listing {"), source.indexOf("}", source.indexOf("pub struct Listing {")));
  const fields = [...struct.matchAll(/pub (\w+):/g)].map((m) => m[1]);
  assert.deepEqual(Object.keys(args.listing).sort(), [...fields].sort());
  assert.equal(args.challenge, "challenge-20261117.kettle.testnet");
  assert.equal(args.listing.practice_set, "https://example.com/p.json");
  assert.equal(args.listing.labeling_guide, null);
  assert.deepEqual(args.listing.baseline, { accuracy_bp: 8700, cost_per_ticket_uusd: 128, p95_latency_ms: 18159 });
  assert.match(listCommand(draft, "registry.testnet"), /near contract call-function as-transaction registry\.testnet list[\s\S]*file-args list-args\.json[\s\S]*sign-as kettle\.testnet network-config testnet/);
});
