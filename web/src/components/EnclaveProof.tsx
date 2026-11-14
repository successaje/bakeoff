/**
 * A result's enclave proof, checked in the visitor's browser on request: OutLayer's Intel TDX
 * quote for the run, verified against Intel's root certificate, tied to the run's record, to the
 * evaluator the challenge pins and to the verdict the contract recorded. What the proof does not
 * cover is listed beside it.
 */

import { useState } from "react";
import { browserVerifier, checkEnclave, type CheckState, type EnclaveReport } from "../lib/attestation.ts";
import { rpcFor } from "../lib/data.ts";
import { utc } from "../lib/format.ts";
import type { Network } from "../lib/near.ts";
import { Check, Close, External, Shield } from "./Icons.tsx";

interface Props {
  network: Network;
  /** The submission transaction, once the page has found it. */
  transaction: string | null;
  lookupError: string | null;
  evaluatorSha256: string;
  verdict: string;
  submitter: string;
}

const MARK: Record<CheckState, string> = { ok: "✓", warn: "!", fail: "✕", skipped: "–" };

function summary(report: EnclaveReport): { label: string; tone: string } {
  const states = report.checks.filter((c) => c.state !== "skipped").map((c) => c.state);
  if (states.includes("fail")) return { label: "Did not verify", tone: "coral" };
  if (states.includes("warn") || report.checks.some((c) => c.id !== "caller" && c.state === "skipped")) return { label: "Partly verified", tone: "amber" };
  return { label: "Verified in your browser", tone: "green" };
}

export function EnclaveProof({ network, transaction, lookupError, evaluatorSha256, verdict, submitter }: Props) {
  const [state, setState] = useState<{ busy?: boolean; report?: EnclaveReport; error?: string }>({});
  const run = async () => {
    if (!transaction) return;
    setState({ busy: true });
    try {
      const report = await checkEnclave(
        { network, transaction, evaluatorSha256, verdict, submitter },
        { fetch: fetch.bind(globalThis), verifier: browserVerifier, rpc: rpcFor(network) },
      );
      setState({ report });
    } catch (error) {
      setState({ error: (error as Error).message });
    }
  };
  const result = state.report ? summary(state.report) : null;

  return (
    <div className="tee-proof">
      <div className="tee-proof-head">
        <span className="check-icon"><Shield /></span>
        <div>
          <h2>Ran in an enclave</h2>
          <p className="text-2 small">OutLayer publishes an Intel-signed quote for every run. Check this one here, in your browser. The check reads OutLayer's public API and NEAR, and sends nothing of yours; the board has no server.</p>
        </div>
        {result && <span className={`badge badge-${result.tone} badge-dot`}>{result.label}</span>}
      </div>

      {!state.report && (
        <div className="tee-proof-run">
          <button type="button" className="btn btn-sm" disabled={!transaction || state.busy} onClick={run}>
            {state.busy && <span className="spinner" aria-hidden="true" />}{state.error ? "Try again" : "Check the enclave proof"}
          </button>
          <span className="muted small">
            {state.busy ? "Loading the verifier (about 670 KB) and Intel's collateral…"
              : state.error ? `Could not check: ${state.error}.`
              : transaction ? "Verifies the quote against Intel's root certificate, then ties it to this result."
              : lookupError ? `The submission transaction could not be found (${lookupError}), and the proof is looked up by it.`
              : "Finding the submission transaction…"}
          </span>
        </div>
      )}

      {state.report && (
        <>
          <ul className="tee-checks">
            {state.report.checks.map((check) => (
              <li key={check.id} className={`tee-check ${check.state}`}>
                <span className="tee-mark" aria-label={check.state}>{check.state === "ok" ? <Check /> : check.state === "fail" ? <Close /> : MARK[check.state]}</span>
                <div><h4>{check.title}</h4><p className="small text-2">{check.text}</p></div>
              </li>
            ))}
          </ul>
          <p className="muted small">
            Attested {utc(state.report.attestedAt)} · OutLayer task {state.report.taskId}
            {state.report.outlayerPage && <> · <a href={state.report.outlayerPage} target="_blank" rel="noopener noreferrer">OutLayer's page for this run <External /></a></>}
          </p>
        </>
      )}

      <details className="tee-limits">
        <summary className="small">What this does not prove</summary>
        <ul className="small text-2">
          <li>That OutLayer's machine image is trustworthy in itself: OutLayer decides which measurements are on its approved list.</li>
          <li>That the result reached the chain from inside the enclave: OutLayer's worker account delivers it, and that account also holds full-access keys. The checks above compare what the chain recorded with the attested output instead.</li>
          <li>That the machine was approved when it ran: the approved list is read as it is today.</li>
          <li>Anything about the model calls, which NEAR AI Cloud serves from its own infrastructure.</li>
        </ul>
      </details>
    </div>
  );
}
