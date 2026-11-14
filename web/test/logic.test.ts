import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptingSubmissions, type ChallengeView, formatNear, isMissingAccount, NearRpc, parseNear, sha256Hex, verdictMetrics } from "../src/lib/near.ts";
import { OneClick, quoteRequest, WNEAR_ASSET } from "../src/lib/oneclick.ts";
import * as tx from "../src/lib/transactions.ts";

test("NEAR amounts parse exactly and refuse anything else", () => {
  assert.equal(parseNear("1"), 10n ** 24n);
  assert.equal(parseNear(" 0.5 "), 5n * 10n ** 23n);
  assert.equal(parseNear("0.000000000000000000000001"), 1n);
  for (const bad of ["", "abc", "-1", "1e3", "1,5", "0", "0.0", "1.0000000000000000000000001"]) {
    assert.throws(() => parseNear(bad), Error, bad);
  }
  assert.equal(formatNear(parseNear("1.23456789")), "1.23456 NEAR");
  assert.equal(formatNear("0"), "0 NEAR");
});

test("hashes match the contract's and verdict metrics are read defensively", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const base = { id: 0, submitter: "a", config_sha256: "", status: "Passed" as const, reasons: [], requested_at: "1", settled_at: null };
  assert.deepEqual(verdictMetrics({ ...base, verdict: '{"metrics":{"accuracy_bp":9300}}' }), { accuracy_bp: 9300 });
  assert.equal(verdictMetrics({ ...base, verdict: "not json" }), null);
  assert.equal(verdictMetrics({ ...base, verdict: null }), null);
});

test("a challenge accepts submissions only while open and before its deadline", () => {
  const now = Date.UTC(2026, 10, 8);
  const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
  const view = (status: ChallengeView["status"], closes: number | null) => ({ status, closes_at: closes === null ? null : ns(closes) }) as ChallengeView;
  assert.equal(acceptingSubmissions(view("Open", now + 1), now), true);
  assert.equal(acceptingSubmissions(view("Open", now), now), false);
  assert.equal(acceptingSubmissions(view("Draft", null), now), false);
  assert.equal(acceptingSubmissions(view("Awarded", now + 1), now), false);
});

test("sponsor transactions carry the contract's methods, deposits and enough gas", () => {
  const amount = parseNear("2");
  assert.deepEqual(tx.fund("c.testnet", amount), {
    receiverId: "c.testnet",
    actions: [{ type: "FunctionCall", params: { methodName: "fund", args: {}, gas: "30000000000000", deposit: String(amount) } }],
  });
  assert.deepEqual(tx.open("c.testnet", 1_794_305_137_861).actions[0]!.params.args, { closes_at: "1794305137861000000" });
  assert.equal(tx.withdrawBounty("c.testnet").actions[0]!.params.deposit, "0");
  assert.equal(tx.claimAward("c.testnet").actions[0]!.params.methodName, "claim_award");
});

test("unwrap-and-fund moves exactly the wNEAR amount into the bounty", () => {
  const amount = parseNear("1.5");
  const [unwrap, fund] = tx.unwrapAndFund("wrap.near", "c.near", amount);
  assert.equal(unwrap!.receiverId, "wrap.near");
  assert.deepEqual(unwrap!.actions[0]!.params, { methodName: "near_withdraw", args: { amount: String(amount) }, gas: "10000000000000", deposit: "1" });
  assert.equal(fund!.receiverId, "c.near");
  assert.equal(fund!.actions[0]!.params.deposit, String(amount));
  const register = tx.registerWnear("wrap.near", "me.near");
  assert.deepEqual(register.actions[0]!.params.args, { account_id: "me.near", registration_only: true });
});

test("1Click is asked for exact wNEAR to the sponsor's account, refunds to their Intents balance", () => {
  const now = Date.UTC(2026, 10, 8, 12);
  const request = quoteRequest({ originAsset: "nep141:eth.omft.near", amountYocto: parseNear("3"), recipient: "me.near", dry: true, now });
  assert.deepEqual(request, {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: "nep141:eth.omft.near",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: WNEAR_ASSET,
    amount: String(parseNear("3")),
    refundTo: "me.near",
    refundType: "INTENTS",
    recipient: "me.near",
    recipientType: "DESTINATION_CHAIN",
    deadline: "2026-11-08T13:00:00.000Z",
    referral: "bakeoff",
  });
});

test("the 1Click client lists swappable tokens and surfaces API errors", async () => {
  const calls: string[] = [];
  const fetchImpl = ((url: string) => {
    calls.push(url);
    if (url.endsWith("/v0/tokens")) {
      return Promise.resolve(new Response(JSON.stringify([
        { assetId: WNEAR_ASSET, decimals: 24, blockchain: "near", symbol: "wNEAR", price: 2 },
        { assetId: "nep141:usdc", decimals: 6, blockchain: "near", symbol: "USDC", price: 1 },
        { assetId: "nep141:eth", decimals: 18, blockchain: "eth", symbol: "ETH", price: 3000 },
        { assetId: "nep141:dead", decimals: 18, blockchain: "eth", symbol: "DEAD", price: 0 },
      ])));
    }
    return Promise.resolve(new Response(JSON.stringify({ message: "amount is too low" }), { status: 400 }));
  }) as typeof fetch;
  const client = new OneClick(fetchImpl);
  assert.deepEqual((await client.tokens()).map((t) => t.symbol), ["ETH", "USDC"]);
  await assert.rejects(client.status("addr", "memo"), /1Click: amount is too low/);
  assert.match(calls.at(-1)!, /\/v0\/status\?depositAddress=addr&depositMemo=memo$/);
});

test("the RPC client reads views and an account's access keys at final finality", async () => {
  const sent: { request_type: string; finality: string }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const { params } = JSON.parse(String(init?.body)) as { params: { request_type: string; finality: string } };
    sent.push(params);
    if (params.request_type === "call_function") {
      return Response.json({ result: { result: [...new TextEncoder().encode('{"status":"Open"}')] } });
    }
    return Response.json({
      result: {
        keys: [
          { public_key: "ed25519:full", access_key: { nonce: 1, permission: "FullAccess" } },
          { public_key: "ed25519:call", access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: "c.near", method_names: [] } } } },
        ],
      },
    });
  }) as typeof fetch;
  const rpc = new NearRpc("https://rpc.example", fetchImpl);
  assert.deepEqual(await rpc.view("c.near", "get_challenge"), { status: "Open" });
  assert.deepEqual(await rpc.accessKeys("c.near"), [
    { publicKey: "ed25519:full", fullAccess: true },
    { publicKey: "ed25519:call", fullAccess: false },
  ]);
  assert.deepEqual(sent.map((p) => [p.request_type, p.finality]), [["call_function", "final"], ["view_access_key_list", "final"]]);
});

test("an RPC error names the call that failed", async () => {
  const fetchImpl = (async () => Response.json({ result: { error: "wasm execution failed" } })) as typeof fetch;
  await assert.rejects(new NearRpc("https://rpc.example", fetchImpl).view("c.near", "get_challenge"), /c\.near\.get_challenge: wasm execution failed/);
});

const viewReply = () => Response.json({ result: { result: [...new TextEncoder().encode('"ok"')] } });
const noWait = { retryDelaysMs: [0, 0, 0, 0] };

test("a refused RPC call is retried until it gets through", async () => {
  // Free RPCs refuse bursts with a 429 that has no CORS headers, which a browser reports as a network error.
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 2) throw new TypeError("Failed to fetch");
    if (calls === 3) return new Response("", { status: 429 });
    return viewReply();
  }) as typeof fetch;
  assert.equal(await new NearRpc("https://rpc.example", fetchImpl, noWait).view("c.near", "get_challenge"), "ok");
  assert.equal(calls, 4);
});

test("a call that keeps failing gives up with a reason, and is not taken for a missing account", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; throw new TypeError("Failed to fetch"); }) as typeof fetch;
  const failure = await new NearRpc("https://rpc.example", fetchImpl, noWait).view("c.near", "get_challenge").catch((e: Error) => e);
  assert.match(String(failure), /NEAR RPC could not be reached \(Failed to fetch\)/);
  assert.equal(calls, 5);
  assert.equal(isMissingAccount(failure), false);
});

test("an account that does not exist is reported at once, as missing", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } }); }) as typeof fetch;
  const failure = await new NearRpc("https://rpc.example", fetchImpl, noWait).view("nobody.near", "get_challenge").catch((e: Error) => e);
  assert.equal(calls, 1);
  assert.equal(isMissingAccount(failure), true);
});

test("no more than four RPC calls run at once", async () => {
  let running = 0, most = 0;
  const fetchImpl = (async () => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return viewReply();
  }) as typeof fetch;
  const rpc = new NearRpc("https://rpc.example", fetchImpl, noWait);
  const results = await Promise.all(Array.from({ length: 12 }, () => rpc.view("c.near", "get_challenge")));
  assert.equal(results.length, 12);
  assert.equal(most, 4);
});
