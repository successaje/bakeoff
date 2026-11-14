/**
 * One result, for the team deciding whether to use it: did it meet each
 * requirement, how it compares with their own agent, what the solution is
 * and how to try it, its limits, and the evidence on-chain.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { reasonText } from "../components/challenge.tsx";
import { Check, Close, Coins, Download, External, Timer } from "../components/Icons.tsx";
import { EnclaveProof } from "../components/EnclaveProof.tsx";
import { ErrorNotice } from "../components/ErrorBoundary.tsx";
import { RetryPayment } from "../components/Manage.tsx";
import { Account, CodeBlock, CopyButton, DemoBadge, DemoNotice, explorer, Reveal } from "../components/ui.tsx";
import { type ChallengeDetail, forget, loadChallenge } from "../lib/data.ts";
import { microDollars, percent, seconds, shortHash, utc } from "../lib/format.ts";
import { challengeGates, type EvaluationView, formatNear, isMissingAccount, nsToDate, verdictMetrics } from "../lib/near.ts";
import { chatRequest, checkRequirements, compareWithBaseline, findSubmission, type Submission, summariseConfig } from "../lib/results.ts";
import { useAsync } from "../lib/hooks.ts";
import { NotFound } from "./NotFound.tsx";

const TICKET_PLACEHOLDER = "<the customer's message>";

interface Outcome {
  headline: string;
  badge: { label: string; tone: string };
}

function outcomeOf(e: EvaluationView, detail: ChallengeDetail): Outcome {
  const award = detail.view.award;
  if (e.status === "Pending") return { headline: "Being scored on the hidden tickets", badge: { label: "Scoring", tone: "badge-amber badge-live" } };
  if (e.status === "Passed") {
    if (award?.evaluation === e.id) return { headline: "Met every requirement and won the reward", badge: { label: "Won", tone: "badge-sky" } };
    if (e.eligible === false) return { headline: "Met every requirement in the owner's trial run", badge: { label: "Passed", tone: "badge-green" } };
    return { headline: "Met every requirement", badge: { label: "Passed", tone: "badge-green" } };
  }
  const why = e.reasons.map(reasonText).join("; ") || "No reason was recorded";
  return { headline: `${e.status === "Rejected" ? "Rejected" : "Did not pass"}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`, badge: { label: e.status, tone: "badge-coral" } };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RewardCard({ e, detail, onChanged }: { e: EvaluationView; detail: ChallengeDetail; onChanged: () => void }) {
  const award = detail.view.award;
  const won = award?.evaluation === e.id;
  return (
    <aside className="bounty-card card reward-card">
      <span className="label"><Coins /> Reward</span>
      {won && award ? (
        <>
          <strong className="bounty-amount amber">{formatNear(award.amount)}</strong>
          {award.paid ? (
            <p className="reward-state ok"><Check /> Paid by the contract with this result</p>
          ) : (
            <>
              <p className="reward-state pending"><Timer /> {award.in_flight ? "Won; the payment is on its way" : "Won; the payment has not completed"}</p>
              <RetryPayment id={detail.listing.id} award={award} onChanged={onChanged} />
            </>
          )}
        </>
      ) : (
        <p className="reward-state">
          {e.status === "Pending" ? "Decided when scoring finishes."
            : e.eligible === false ? "Not eligible: the owner's own submissions are trial runs."
            : e.status === "Passed" && award ? <>Not awarded: result <Link to={`/challenges/${detail.listing.id}/results/${award.evaluation}`}>#{award.evaluation}</Link> won first.</>
            : e.status === "Passed" ? "Not awarded."
            : "Not awarded: a result must meet every requirement."}
        </p>
      )}
    </aside>
  );
}

function Solution({ submission, error, loading, configSha }: { submission: Submission | null; error: Error | null; loading: boolean; configSha: string }) {
  if (loading) return <p className="muted"><span className="spinner" aria-hidden="true" /> Finding the submission transaction…</p>;
  if (error || !submission) {
    return (
      <p className="notice">
        {error ? `Could not load the config: ${error.message}.` : "The submission transaction was not found among the submitter's recent transactions."}{" "}
        Its SHA-256 is <span className="mono break">{configSha}</span>; paste a config on the challenge page to check it against this result.
      </p>
    );
  }
  const facts = summariseConfig(submission.config);
  return (
    <>
      <dl className="config-facts">
        <div><dt>Model</dt><dd className="mono">{facts.model}</dd></div>
        <div><dt>Instructions</dt><dd>{facts.promptCharacters.toLocaleString()} characters</dd></div>
        <div><dt>Worked examples</dt><dd>{facts.examples || "None"}</dd></div>
        <div><dt>Reply limit</dt><dd>{facts.maxTokens} tokens</dd></div>
        {facts.options.length > 0 && <div><dt>Model options</dt><dd className="mono">{facts.options.join(", ")}</dd></div>}
        {facts.escalation && <div><dt>Second opinion</dt><dd className="mono">{facts.escalation}</dd></div>}
      </dl>
      <pre className="code config-code">{JSON.stringify(JSON.parse(submission.config), null, 2)}</pre>
      <div className="row">
        <CopyButton text={submission.config} label="Copy the config" />
        <button type="button" className="btn btn-sm" onClick={() => download("bakeoff-config.json", submission.config)}><Download /> Download the config</button>
        <span className="outcome ok"><Check /> Hashes to this result's record</span>
      </div>
    </>
  );
}

export function Result() {
  const { id = "", n = "" } = useParams();
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useAsync(() => loadChallenge(id, version > 0), `${id}:${version}`);
  const refresh = () => {
    forget(id);
    setVersion((v) => v + 1);
  };
  const index = Number(n);
  const e = data?.evaluations.find((x) => x.id === index);
  const pending = e?.status === "Pending";
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, id]);
  const lookup = useAsync(
    () => (data && e ? findSubmission(data.network, id, e.submitter, e.config_sha256) : Promise.resolve(null)),
    `${id}:${e?.submitter ?? ""}:${e?.config_sha256 ?? ""}`,
  );
  const verdict = useMemo(() => {
    try {
      return e?.verdict ? (JSON.parse(e.verdict) as { rules_sha256?: string; test_set_sha256?: string }) : null;
    } catch {
      return null;
    }
  }, [e?.verdict]);

  if (!data) {
    if (error && !loading) {
      return isMissingAccount(error) ? <NotFound what="challenge" /> : (
        <div className="container page-body"><ErrorNotice error={new Error(`Could not read ${id} from NEAR: ${error.message}`)} onRetry={refresh} /></div>
      );
    }
    return <div className="container page-body"><div className="skeleton" style={{ height: 56, width: "60%", marginBottom: 32 }} /><div className="skeleton skeleton-card" /></div>;
  }
  if (!Number.isInteger(index) || !e) return <NotFound what="result" />;

  const { listing, view, network } = data;
  const gates = challengeGates(view);
  const metrics = verdictMetrics(e);
  const outcome = outcomeOf(e, data);
  const checks = gates ? checkRequirements(gates, metrics, listing.baseline, { percent, micro: microDollars, seconds }) : [];
  const changes = compareWithBaseline(metrics, listing.baseline);
  const requested = nsToDate(e.requested_at);
  const settled = nsToDate(e.settled_at);
  const tookSeconds = requested && settled ? (settled.getTime() - requested.getTime()) / 1000 : null;
  const submission = lookup.data;
  const request = submission ? JSON.stringify(chatRequest(view.rules_json, submission.config, TICKET_PLACEHOLDER), null, 2) : null;
  const rules = JSON.parse(view.rules_json) as { endpoint?: string; max_concurrency?: number };
  const endpoint = rules.endpoint ?? "";
  // The evaluator's default when the rules do not set it.
  const concurrency = rules.max_concurrency ?? 8;
  const ids = data.evaluations.map((x) => x.id);
  const previous = ids.filter((x) => x < index).at(-1);
  const next = ids.find((x) => x > index);

  return (
    <div className="page result-page">
      <div className="page-hero grid-bg-wrap">
        <div className="grid-bg page-grid" aria-hidden="true" />
        <div className="container">
          <Link to={`/challenges/${id}`} className="back-link">← {listing.title}</Link>
          <div className="challenge-head">
            <Reveal immediate>
              <div className="challenge-meta">
                <span className="eyebrow-plain">Result #{e.id}</span>
                <span className={`badge badge-dot ${outcome.badge.tone}`}>{e.status === "Pending" ? <span className="shimmer-text on-color">{outcome.badge.label}</span> : outcome.badge.label}</span>
                {e.eligible === false && <span className="badge trial">Owner's trial</span>}
                {listing.demo && <DemoBadge />}
              </div>
              <h1 className="page-title result-title">{outcome.headline}</h1>
              <p className="page-lede">
                Submitted to {listing.sponsor}'s <Link to={`/challenges/${id}`}>{listing.title.toLowerCase()}</Link> challenge by <Account id={e.submitter} network={network} />
                {requested && <> on {utc(requested)}</>}{tookSeconds !== null && <>, and recorded {tookSeconds.toFixed(0)} s later</>}.
              </p>
            </Reveal>
            <RewardCard e={e} detail={data} onChanged={refresh} />
          </div>
        </div>
      </div>

      <div className="container page-body result-body">
        {listing.demo && <DemoNotice sponsor={listing.sponsor} network={network} />}

        <Reveal className="card card-pad result-section">
          <h2>Requirements</h2>
          <p className="muted small">Each requirement is part of the contract's rules. The baseline is the figure {listing.sponsor} published for its current agent.</p>
          {checks.length > 0 && (
            <div className="table-wrap">
              <table className="table requirements">
                <thead><tr><th>Requirement</th><th className="num">Needed</th><th className="num">This result</th><th className="num">Baseline</th><th>Met</th></tr></thead>
                <tbody>
                  {checks.map((c) => (
                    <tr key={c.label}>
                      <td>{c.label}</td>
                      <td className="num">{c.needed}</td>
                      <td className={`num ${c.met === false ? "coral" : ""}`}><strong>{c.value}</strong></td>
                      <td className="num muted">{c.baseline ?? "–"}</td>
                      <td>{c.met === null ? <span className="muted">–</span> : c.met ? <span className="met yes"><Check /> Yes</span> : <span className="met no"><Close /> No</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {e.reasons.some((r) => !r.startsWith("gate_")) && (
            <p className="notice">The evaluator also recorded: {e.reasons.filter((r) => !r.startsWith("gate_")).map(reasonText).join("; ")}.</p>
          )}
          {metrics && (
            <p className="muted small">
              Also measured: category alone {percent(metrics.category_accuracy_bp)} · {metrics.invalid_answers ?? 0} replies in the wrong format · {metrics.tickets ?? listing.tickets} hidden tickets.
            </p>
          )}
        </Reveal>

        {changes.length > 0 && (
          <Reveal className="result-section">
            <h2>Compared with the baseline</h2>
            <div className="change-grid">
              {changes.map((c) => (
                <div key={c.label} className={`change card ${c.better >= 0 ? "better" : "worse"}`}>
                  <span className="label">{c.label}</span>
                  <strong>{c.text}</strong>
                </div>
              ))}
            </div>
          </Reveal>
        )}

        <Reveal className="card card-pad result-section">
          <h2>The solution</h2>
          <p className="muted small">A solution is a config: the model, its instructions, any worked examples and limits. Configs are public once submitted, so the owner can adopt the winner.</p>
          <Solution submission={submission ?? null} error={lookup.error} loading={lookup.loading} configSha={e.config_sha256} />
        </Reveal>

        {e.status === "Passed" && request && (
          <Reveal className="card card-pad result-section">
            <h2>Try it safely</h2>
            <ol className="try-steps">
              <li>
                <h3>Get the exact request</h3>
                <p className="text-2 small">This is what the evaluator sent the model for each hidden ticket, with <span className="mono">{TICKET_PLACEHOLDER}</span> where the ticket goes.</p>
                <button type="button" className="btn btn-sm" onClick={() => download("bakeoff-request.json", request)}><Download /> Download request.json</button>
              </li>
              <li>
                <h3>Run it beside your current agent</h3>
                <p className="text-2 small">Send the same recent tickets to both, with your own NEAR AI Cloud key, and compare the answers and the cost before changing anything.</p>
                <CodeBlock code={`curl ${endpoint} \\\n  -H "Authorization: Bearer $NEARAI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d @request.json`} />
              </li>
              <li>
                <h3>Switch over gradually</h3>
                <p className="text-2 small">Move a share of traffic at a time and keep measuring accuracy, cost and latency. The hidden test is {listing.tickets} tickets, not your whole production mix.</p>
              </li>
            </ol>
          </Reveal>
        )}

        <Reveal className="card card-pad result-section">
          <h2>Limitations</h2>
          <ul className="plain-list">
            <li>It was scored on {listing.tickets || "the"} hidden tickets that {listing.sponsor} wrote and labelled. Your own traffic may differ.</li>
            <li>A ticket counts as correct only when both its team and its priority match the label. The one-line summary is required and checked for card numbers, but its quality is not graded.</li>
            <li>Cost is computed from the tokens each reply used, at the model prices in the rules, not from an invoice.</li>
            <li>Latency was measured from inside the enclave, with up to {concurrency} tickets in flight at once, as the rules set. Your network and load will add their own.</li>
            {listing.demo && <li>This is a demonstration round; see the notice above.</li>}
          </ul>
        </Reveal>

        <Reveal className="card card-pad result-section">
          <h2>Evidence</h2>
          <dl className="evidence">
            {submission && (
              <div><dt>Submission</dt><dd><a className="mono" href={explorer(network, "txns", submission.transaction)} target="_blank" rel="noopener noreferrer">{shortHash(submission.transaction)} <External /></a><span className="muted small">The result was recorded, and any reward paid, in this transaction's receipts.</span></dd></div>
            )}
            <div><dt>Result record</dt><dd><span className="mono small">get_evaluation {`{"id": ${e.id}}`}</span><span className="muted small">on <a href={explorer(network, "address", id)} target="_blank" rel="noopener noreferrer">{id}</a></span></dd></div>
            <div><dt>Config</dt><dd><span className="mono break small">{e.config_sha256}</span></dd></div>
            {verdict?.rules_sha256 && (
              <div><dt>Rules</dt><dd><span className="mono break small">{verdict.rules_sha256}</span>{verdict.rules_sha256 === view.rules_sha256 ? <span className="met yes"><Check /> The challenge's commitment</span> : <span className="met no"><Close /> Not the challenge's commitment</span>}</dd></div>
            )}
            {verdict?.test_set_sha256 && (
              <div><dt>Hidden test set</dt><dd><span className="mono break small">{verdict.test_set_sha256}</span>{verdict.test_set_sha256 === view.test_set_sha256 ? <span className="met yes"><Check /> The challenge's commitment</span> : <span className="met no"><Close /> Not the challenge's commitment</span>}</dd></div>
            )}
            <div><dt>Evaluator build</dt><dd><span className="mono break small">{view.evaluator.sha256}</span><span className="muted small">Pinned by the challenge; check it on the challenge page.</span></dd></div>
            <div><dt>Requested</dt><dd>{utc(requested)}</dd></div>
            <div><dt>Recorded</dt><dd>{settled ? utc(settled) : "Not yet"}</dd></div>
          </dl>
        </Reveal>

        {e.verdict && (
          <Reveal className="card card-pad result-section">
            <EnclaveProof network={network} transaction={submission?.transaction ?? null} lookupError={lookup.error?.message ?? null} evaluatorSha256={view.evaluator.sha256} verdict={e.verdict} submitter={e.submitter} />
          </Reveal>
        )}

        <nav className="result-nav" aria-label="Other results">
          {previous !== undefined ? <Link to={`/challenges/${id}/results/${previous}`} className="btn btn-ghost">← Result #{previous}</Link> : <span />}
          <Link to={{ pathname: `/challenges/${id}`, hash: "results" }} className="btn btn-ghost">All results</Link>
          {next !== undefined ? <Link to={`/challenges/${id}/results/${next}`} className="btn btn-ghost">Result #{next} →</Link> : <span />}
        </nav>
      </div>
    </div>
  );
}
