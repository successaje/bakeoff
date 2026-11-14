import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Attestation, checkEnclave, type EnclaveDeps, type EnclaveInput, type QuoteVerifier, taskHash } from "../src/lib/attestation.ts";
import { initSync, quote_platform, verify_quote } from "../src/vendor/quote-verifier/quote_verifier.js";

// The mainnet round's winning result, its attestation and Intel's collateral for the time of
// the run, as OutLayer published them. The quote is checked by the same WebAssembly verifier the
// board loads.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
const ATTESTATION: Attestation = fixture("attestation-mainnet.json");
const COLLATERAL = fixture("collateral-mainnet.json");
const RESULT = fixture("evaluation-mainnet.json");
initSync({ module: readFileSync(new URL("../src/vendor/quote-verifier/quote_verifier_bg.wasm", import.meta.url)) });
const verifier = { quote_platform, verify_quote } as unknown as QuoteVerifier;

const input: EnclaveInput = { network: "mainnet", transaction: RESULT.transaction, evaluatorSha256: RESULT.evaluator_sha256, verdict: RESULT.verdict, submitter: RESULT.submitter };

function deps({ attestation = ATTESTATION, approved = true }: { attestation?: Attestation | null; approved?: boolean } = {}): EnclaveDeps {
  return {
    fetch: (async (url: string) => {
      if (url.includes("/attestations/by-tx/")) return attestation ? Response.json(attestation) : new Response("", { status: 404 });
      if (url.includes("/public/collateral")) return Response.json(COLLATERAL);
      return new Response("", { status: 500 });
    }) as typeof fetch,
    verifier: async () => verifier,
    rpc: { view: (async (account: string, method: string) => {
      assert.equal(account, "worker.outlayer.near");
      assert.equal(method, "is_measurements_approved");
      return approved;
    }) as EnclaveDeps["rpc"]["view"] },
  };
}

const states = (report: Awaited<ReturnType<typeof checkEnclave>>) => Object.fromEntries(report.checks.map((c) => [c.id, c.state]));

test("the mainnet winner's enclave proof checks out end to end", async () => {
  const report = await checkEnclave(input, deps());
  assert.deepEqual(states(report), { signed: "ok", binding: "ok", build: "ok", output: "ok", caller: "ok", approved: "ok" });
  assert.equal(report.taskId, 1307308);
  assert.equal(report.outlayerPage, "https://app.outlayer.ai/attestation/1307308");
  assert.match(report.checks[0]!.text, /up to date/);
});

test("the task hash is the one inside the signed quote", async () => {
  const verified = verifier.verify_quote(Uint8Array.from(Buffer.from(ATTESTATION.tdx_quote, "base64")), COLLATERAL.collateral, ATTESTATION.timestamp);
  assert.equal(verified.ok, true);
  assert.equal(verified.report_data!.slice(0, 64), await taskHash(ATTESTATION));
});

test("a verdict the enclave did not produce is caught", async () => {
  const forged = RESULT.verdict.replace('"accuracy_bp":8900', '"accuracy_bp":9900');
  assert.notEqual(forged, RESULT.verdict);
  assert.deepEqual(states(await checkEnclave({ ...input, verdict: forged }, deps())), { signed: "ok", binding: "ok", build: "ok", output: "fail", caller: "ok", approved: "ok" });
});

test("a run of a different evaluator is caught", async () => {
  const report = await checkEnclave({ ...input, evaluatorSha256: "0".repeat(64) }, deps());
  assert.equal(states(report).build, "fail");
});

test("a record edited after the quote was signed no longer matches it", async () => {
  const edited = { ...ATTESTATION, output_hash: "f".repeat(64) };
  const s = states(await checkEnclave(input, deps({ attestation: edited })));
  assert.equal(s.signed, "ok");
  assert.equal(s.binding, "fail");
});

test("a tampered quote fails Intel's check, and nothing after it is claimed", async () => {
  const quote = Buffer.from(ATTESTATION.tdx_quote, "base64");
  quote[700] = quote[700]! ^ 1;
  const s = states(await checkEnclave(input, deps({ attestation: { ...ATTESTATION, tdx_quote: quote.toString("base64") } })));
  assert.equal(s.signed, "fail");
  assert.equal(s.binding, "skipped");
  assert.equal(s.approved, "skipped");
});

test("a machine that is not on OutLayer's approved list is reported", async () => {
  assert.equal(states(await checkEnclave(input, deps({ approved: false }))).approved, "fail");
});

test("a result with no attestation says so instead of passing", async () => {
  await assert.rejects(checkEnclave(input, deps({ attestation: null })), /no attestation/);
});
