/**
 * Checking, in the browser, that a result came out of a genuine enclave.
 *
 * OutLayer publishes an attestation for every run: an Intel TDX quote, signed by the hardware,
 * whose report data commits to a hash of the run's record (task, code, input, output, caller).
 * This module fetches the attestation for a result's submission transaction and checks it on
 * three levels, the way OutLayer's own verifier does:
 *
 *   1. the quote is genuine: Intel's signature chain, against the collateral Intel published for
 *      the moment of the run (the WebAssembly verifier in web/quote-verifier does this);
 *   2. the quote commits to the published record;
 *   3. the machine's measurements are on OutLayer's approved list;
 *
 * and then ties the record to this challenge: the attested build is the evaluator the contract
 * pins, the attested output is the verdict the contract recorded, and the run was requested for
 * the result's submitter.
 *
 * Nothing here trusts OutLayer's API: the quote and the collateral are inputs, and a tampered
 * one fails. What the checks do not cover is listed on the page beside them.
 */

import { type NearRpc, type Network, sha256Hex } from "./near.ts";

const OUTLAYER: Record<Network, { api: string; register: string; app?: string }> = {
  mainnet: { api: "https://api.outlayer.ai", register: "worker.outlayer.near", app: "https://app.outlayer.ai/attestation" },
  testnet: { api: "https://testnet-api.outlayer.ai", register: "worker.outlayer.testnet" },
};

/** Records from this moment on commit to the caller, secrets and timestamp too (OutLayer's format V1). */
export const V1_CUTOFF = 1_769_784_939;

/** A run's attestation as OutLayer publishes it. */
export interface Attestation {
  task_id: number;
  task_type: string;
  tdx_quote: string;
  /** Unix seconds: when the run was attested, and the moment the quote is judged as of. */
  timestamp: number;
  output_hash: string;
  input_hash?: string | null;
  repo_url?: string | null;
  commit_hash?: string | null;
  build_target?: string | null;
  wasm_hash?: string | null;
  block_height?: number | null;
  caller_account_id?: string | null;
  project_id?: string | null;
  secrets_ref?: string | null;
  attached_usd?: string | null;
  transaction_hash?: string | null;
}

export interface Measurements { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string }

/** The WebAssembly verifier's interface (web/quote-verifier). */
export interface QuoteVerifier {
  quote_platform(quote: Uint8Array): { ok: boolean; error?: string; fmspc?: string };
  verify_quote(quote: Uint8Array, collateral: string, atSeconds: number): {
    ok: boolean;
    error?: string;
    status?: string;
    advisory_ids?: string[];
    measurements?: Measurements;
    report_data?: string;
  };
}

/**
 * The hash OutLayer's worker puts in the first 32 bytes of report_data before the quote is
 * signed. The encoding is part of OutLayer's format: strings as UTF-8, task_id and timestamp as
 * little-endian i64, block_height as little-endian u64, and absent fields contributing nothing.
 */
export async function taskHash(att: Attestation): Promise<string> {
  const text = new TextEncoder();
  const parts: Uint8Array[] = [];
  const int64 = (value: number, signed: boolean) => {
    const view = new DataView(new ArrayBuffer(8));
    if (signed) view.setBigInt64(0, BigInt(value), true);
    else view.setBigUint64(0, BigInt(value), true);
    return new Uint8Array(view.buffer);
  };
  const add = (value: string | null | undefined) => { if (value) parts.push(text.encode(value)); };
  add(att.task_type);
  parts.push(int64(att.task_id, true));
  add(att.repo_url);
  add(att.commit_hash);
  add(att.build_target);
  add(att.wasm_hash);
  add(att.input_hash);
  parts.push(text.encode(att.output_hash));
  if (att.block_height) parts.push(int64(att.block_height, false));
  if (att.timestamp >= V1_CUTOFF) {
    add(att.caller_account_id);
    add(att.project_id);
    add(att.secrets_ref);
    parts.push(int64(att.timestamp, true));
    add(att.attached_usd);
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return sha256Hex(bytes.buffer);
}

export type CheckState = "ok" | "warn" | "fail" | "skipped";

export interface EnclaveCheck {
  id: "signed" | "binding" | "build" | "output" | "caller" | "approved";
  title: string;
  state: CheckState;
  text: string;
}

export interface EnclaveReport {
  checks: EnclaveCheck[];
  taskId: number;
  attestedAt: Date;
  /** OutLayer's own page for the run, for a second opinion. */
  outlayerPage?: string;
}

export interface EnclaveInput {
  network: Network;
  transaction: string;
  evaluatorSha256: string;
  verdict: string;
  submitter: string;
}

export interface EnclaveDeps {
  fetch: typeof fetch;
  verifier: () => Promise<QuoteVerifier>;
  rpc: Pick<NearRpc, "view">;
}

/** Loads the WebAssembly verifier the first time a check needs it; about 670 KB. */
export async function browserVerifier(): Promise<QuoteVerifier> {
  const module = await import("../vendor/quote-verifier/quote_verifier.js");
  await module.default();
  return module as unknown as QuoteVerifier;
}

const short = (hash: string) => `${hash.slice(0, 10)}…`;

function base64Bytes(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function json<T>(fetchImpl: typeof fetch, url: string, what: string): Promise<T> {
  const response = await fetchImpl(url);
  if (response.status === 404) throw new Error(`OutLayer has no ${what} for this run`);
  if (!response.ok) throw new Error(`OutLayer's API answered HTTP ${response.status} for the ${what}`);
  return (await response.json()) as T;
}

/**
 * Runs every check for one result. Throws only when there is nothing to check (no attestation);
 * a check that fails or cannot run is reported as such, and the others still run.
 */
export async function checkEnclave(input: EnclaveInput, deps: EnclaveDeps): Promise<EnclaveReport> {
  const outlayer = OUTLAYER[input.network];
  const att = await json<Attestation>(deps.fetch, `${outlayer.api}/attestations/by-tx/${input.transaction}`, "attestation");

  const signed: EnclaveCheck = { id: "signed", title: "Signed by Intel hardware", state: "skipped", text: "Not checked." };
  const binding: EnclaveCheck = { id: "binding", title: "Commits to this run", state: "skipped", text: "Not checked: the quote has to verify first." };
  const approved: EnclaveCheck = { id: "approved", title: "An approved OutLayer machine", state: "skipped", text: "Not checked: the quote has to verify first." };

  // Ties between the record and this challenge. These need no verifier, but they only mean
  // something once the quote is shown to commit to the record.
  const build: EnclaveCheck = att.wasm_hash === input.evaluatorSha256
    ? { id: "build", title: "Ran the pinned evaluator", state: "ok", text: `The attested build is ${short(att.wasm_hash)}, the evaluator the challenge pins.` }
    : { id: "build", title: "Ran the pinned evaluator", state: "fail", text: `The attested build is ${att.wasm_hash ? short(att.wasm_hash) : "missing"}, not the evaluator the challenge pins (${short(input.evaluatorSha256)}).` };
  const outputHash = await sha256Hex(input.verdict);
  const output: EnclaveCheck = outputHash === att.output_hash
    ? { id: "output", title: "Produced this verdict", state: "ok", text: "The attested output hashes to the verdict the contract recorded, byte for byte." }
    : { id: "output", title: "Produced this verdict", state: "fail", text: `The attested output (${short(att.output_hash)}) is not the verdict the contract recorded (${short(outputHash)}).` };
  const caller: EnclaveCheck = !att.caller_account_id || att.timestamp < V1_CUTOFF
    ? { id: "caller", title: "Requested by the submitter", state: "skipped", text: "This record's format does not commit to who requested the run." }
    : att.caller_account_id === input.submitter
      ? { id: "caller", title: "Requested by the submitter", state: "ok", text: `The run was requested for ${att.caller_account_id}, who submitted this result.` }
      : { id: "caller", title: "Requested by the submitter", state: "fail", text: `The run was requested for ${att.caller_account_id}, not ${input.submitter}.` };

  const report = (): EnclaveReport => ({
    checks: [signed, binding, build, output, caller, approved],
    taskId: att.task_id,
    attestedAt: new Date(att.timestamp * 1000),
    outlayerPage: outlayer.app ? `${outlayer.app}/${att.task_id}` : undefined,
  });

  const quote = base64Bytes(att.tdx_quote);
  if (new TextDecoder().decode(quote) === "no-attestation-dev-mode") {
    Object.assign(signed, { state: "fail", text: "OutLayer ran this without a TEE, in development mode: there is no quote." });
    return report();
  }

  let verifier: QuoteVerifier;
  try {
    verifier = await deps.verifier();
  } catch (error) {
    Object.assign(signed, { state: "warn", text: `The verifier could not load: ${(error as Error).message}.` });
    return report();
  }
  const platform = verifier.quote_platform(quote);
  if (!platform.ok || !platform.fmspc) {
    Object.assign(signed, { state: "fail", text: platform.error ?? "The quote could not be decoded." });
    return report();
  }

  // A past run is judged by the collateral Intel published for that moment, not today's.
  let collateral: { collateral: string | object; covers_requested_time?: boolean };
  try {
    collateral = await json(deps.fetch, `${outlayer.api}/public/collateral?fmspc=${encodeURIComponent(platform.fmspc)}&at=${att.timestamp}`, "Intel collateral");
  } catch (error) {
    Object.assign(signed, { state: "warn", text: `${(error as Error).message}, so the signature could not be checked.` });
    return report();
  }
  const body = typeof collateral.collateral === "string" ? collateral.collateral : JSON.stringify(collateral.collateral);
  const verified = verifier.verify_quote(quote, body, att.timestamp);
  if (!verified.ok) {
    Object.assign(signed, { state: "fail", text: `The quote does not verify against Intel's root certificate: ${verified.error ?? "unknown error"}.` });
    return report();
  }
  const status = verified.status ?? "unknown";
  const advisories = verified.advisory_ids?.length ? ` Intel advisories: ${verified.advisory_ids.join(", ")}.` : "";
  Object.assign(signed, status === "UpToDate"
    ? { state: "ok", text: `A genuine Intel TDX quote: its signatures chain to Intel's root certificate, checked against the collateral Intel published for the time of the run. Platform status: up to date.${advisories}` }
    : { state: "warn", text: `The signature chain to Intel's root certificate holds, but Intel rates the platform "${status}" for the time of the run.${advisories}` });
  if (collateral.covers_requested_time === false) {
    Object.assign(signed, { state: "warn", text: `${signed.text} No published collateral covers the exact time of the run; the nearest was used.` });
  }

  const expected = await taskHash(att);
  const committed = verified.report_data?.slice(0, 64);
  Object.assign(binding, committed === expected
    ? { state: "ok", text: `Inside the signed quote is the hash of this run's record: task ${att.task_id}, the build, the input, the output${att.timestamp >= V1_CUTOFF ? ", who requested it and when" : ""}.` }
    : { state: "fail", text: `The quote commits to ${committed ? short(committed) : "nothing"}, not to this run's record (${short(expected)}).` });

  if (verified.measurements) {
    try {
      const ok = await deps.rpc.view<boolean>(outlayer.register, "is_measurements_approved", { measurements: verified.measurements });
      Object.assign(approved, ok
        ? { state: "ok", text: `The machine's measurements are on OutLayer's approved list in ${outlayer.register}, as of now.` }
        : { state: "fail", text: `The machine's measurements are not on OutLayer's approved list in ${outlayer.register}.` });
    } catch (error) {
      Object.assign(approved, { state: "warn", text: `The approved list could not be read: ${(error as Error).message}.` });
    }
  }
  return report();
}
