import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureEvaluator, sha256Hex } from "../src/evaluator.ts";

const BYTES = new TextEncoder().encode("\0asm pretend evaluator");
const SHA = sha256Hex(BYTES);

function serving(bytes: Uint8Array) {
  const fetched: string[] = [];
  const fetchImpl = ((url: string) => {
    fetched.push(url);
    return Promise.resolve(new Response(bytes));
  }) as typeof fetch;
  return { fetched, fetchImpl };
}

test("a build whose hash matches the challenge is cached and reused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakeoff-mcp-"));
  const { fetched, fetchImpl } = serving(BYTES);
  const build = { url: "https://fastfs.example/e.wasm", sha256: SHA };

  const path = await ensureEvaluator(build, dir, fetchImpl);
  assert.equal(path, join(dir, `${SHA}.wasm`));
  assert.deepEqual(new Uint8Array(await readFile(path)), BYTES);
  await ensureEvaluator(build, dir, fetchImpl);
  assert.equal(fetched.length, 1);
});

test("a build whose hash differs from the challenge's commitment is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakeoff-mcp-"));
  const { fetchImpl } = serving(new TextEncoder().encode("something else"));
  await assert.rejects(
    ensureEvaluator({ url: "https://fastfs.example/e.wasm", sha256: SHA }, dir, fetchImpl),
    /not the [0-9a-f]{64} the challenge pins; refusing to run it/,
  );
});

test("a hash that is not a SHA-256 is refused before anything is fetched", async () => {
  const { fetched, fetchImpl } = serving(BYTES);
  await assert.rejects(ensureEvaluator({ url: "https://x", sha256: "../../etc/passwd" }, "/tmp", fetchImpl), /not a SHA-256/);
  assert.equal(fetched.length, 0);
});
