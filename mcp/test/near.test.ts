import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNear, NearRpc, nsToIso } from "../src/near.ts";

function rpcAnswering(body: unknown) {
  const requests: unknown[] = [];
  const fetchImpl = ((_: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return Promise.resolve(new Response(JSON.stringify(body)));
  }) as typeof fetch;
  return { requests, rpc: new NearRpc("https://rpc.example", fetchImpl) };
}

test("view calls encode their arguments and decode the contract's JSON", async () => {
  const value = { status: "Open" };
  const { requests, rpc } = rpcAnswering({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
  assert.deepEqual(await rpc.getEvaluations("c.testnet", 3, 20), value);
  const params = (requests[0] as { params: { method_name: string; args_base64: string } }).params;
  assert.equal(params.method_name, "get_evaluations");
  assert.deepEqual(JSON.parse(Buffer.from(params.args_base64, "base64").toString()), { from_index: 3, limit: 20 });
});

test("RPC errors and contract panics are reported with the method", async () => {
  const missing = rpcAnswering({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } });
  await assert.rejects(missing.rpc.getChallenge("gone.testnet"), /gone.testnet.get_challenge failed: UNKNOWN_ACCOUNT/);
  const panic = rpcAnswering({ result: { error: "wasm execution failed with error: MethodNotFound" } });
  await assert.rejects(panic.rpc.getChallenge("old.testnet"), /MethodNotFound/);
});

test("amounts and timestamps are shown the way people read them", () => {
  assert.equal(formatNear("1000000000000000000000000"), "1 NEAR");
  assert.equal(formatNear("35000000000000000000000"), "0.035 NEAR");
  assert.equal(formatNear("0"), "0 NEAR");
  assert.equal(nsToIso("1794305137861448000"), "2026-11-10T10:05:37.861Z");
  assert.equal(nsToIso(null), null);
});
