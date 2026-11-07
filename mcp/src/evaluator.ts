/**
 * Practice scoring with the exact evaluator build a challenge pins.
 *
 * The build is fetched from the challenge's URL and kept only if its
 * SHA-256 matches the contract's commitment, so a practice score comes from
 * the same binary the OutLayer TEE runs on the sealed set.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvaluatorBuild } from "./near.ts";

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Returns the path of a verified copy of `build`, fetching it if needed. */
export async function ensureEvaluator(
  build: EvaluatorBuild,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(build.sha256)) {
    throw new Error(`evaluator hash ${build.sha256} is not a SHA-256`);
  }
  const path = join(cacheDir, `${build.sha256}.wasm`);
  if (existsSync(path) && sha256Hex(await readFile(path)) === build.sha256) {
    return path;
  }
  const response = await fetchImpl(build.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`fetching the evaluator from ${build.url} failed: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual !== build.sha256) {
    throw new Error(
      `the evaluator at ${build.url} has SHA-256 ${actual}, not the ${build.sha256} the challenge pins; refusing to run it`,
    );
  }
  await mkdir(cacheDir, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path);
  return path;
}

/** The verdict the evaluator prints; the fields callers use are typed. */
export interface Verdict {
  passed: boolean;
  reasons: string[];
  metrics: Record<string, number> | null;
  rules_sha256: string;
  config_sha256: string;
  test_set_sha256: string;
  [key: string]: unknown;
}

export interface EvaluatorRun {
  verdict: Verdict;
  /** The evaluator's transport log, last lines only. It never holds the API key. */
  log: string[];
}

export interface RunOptions {
  wasmtime: string;
  wasmPath: string;
  rulesJson: string;
  configJson: string;
  testSetJson: string;
  apiKey: string;
  timeoutMs?: number;
}

/**
 * Runs the evaluator in dev mode on a supplied test set. The API key is
 * forwarded to the guest by name, so it never appears in a process listing.
 */
export function runEvaluator(options: RunOptions): Promise<EvaluatorRun> {
  const request = JSON.stringify({
    mode: "dev",
    rules_json: options.rulesJson,
    config_json: options.configJson,
    test_set_json: options.testSetJson,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.wasmtime,
      ["run", "-S", "http", "--env", "BAKEOFF_LLM_API_KEY", options.wasmPath],
      {
        env: { ...process.env, BAKEOFF_LLM_API_KEY: options.apiKey },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the evaluator did not finish within ${(options.timeoutMs ?? 150_000) / 1000} s`));
    }, options.timeoutMs ?? 150_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${options.wasmtime}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const log = Buffer.concat(stderr).toString("utf8").trim().split("\n").filter(Boolean).slice(-20);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      try {
        resolve({ verdict: JSON.parse(out) as Verdict, log });
      } catch {
        reject(new Error(`the evaluator exited with ${code} and no verdict: ${log.slice(-5).join(" | ")}`));
      }
    });
    child.stdin.end(request);
  });
}

/** Reads public material from a local path or an https URL. */
export async function readMaterial(location: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (/^https:\/\//.test(location)) {
    const response = await fetchImpl(location, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`fetching ${location} failed: HTTP ${response.status}`);
    return response.text();
  }
  return readFile(location, "utf8");
}
