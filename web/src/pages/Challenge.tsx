import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { costCut, TheBar, VerdictTable } from "../components/challenge.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { ArrowRight, Check, Coins, Cube, Hash, Lock, Timer } from "../components/Icons.tsx";
import { SponsorPanel } from "../components/Sponsor.tsx";
import { Account, CodeBlock, CopyButton, Countdown, DemoBadge, DemoNotice, displayStatus, explorer, Reveal, StatusBadge, Tabs } from "../components/ui.tsx";
import { type ChallengeDetail, forget, loadChallenge, rpcFor } from "../lib/data.ts";
import { microDollars, percent, utc } from "../lib/format.ts";
import { challengeGates, type EvaluationView, formatNear, type Metrics, nsToDate, sha256Hex, verdictMetrics } from "../lib/near.ts";
import { useAsync, usePrefersReducedMotion } from "../lib/hooks.ts";
import { useSession } from "../lib/session.tsx";
import { NotFound } from "./NotFound.tsx";

type Tab = "verdicts" | "verify" | "compete" | "sponsor";

/** The winner's metrics, else the best passing run, else nothing to plot. */
function bestRun(detail: ChallengeDetail): { metrics: Metrics | null; label: string } {
  if (detail.winner) return { metrics: detail.winner, label: "Winner" };
  const passed = detail.evaluations.filter((e) => e.status === "Passed").map(verdictMetrics).filter((m): m is Metrics => m !== null);
  passed.sort((a, b) => (b.accuracy_bp ?? 0) - (a.accuracy_bp ?? 0));
  return { metrics: passed[0] ?? null, label: "Best pass" };
}

/** A check that ran and found a different hash, as opposed to one that could not run. */
class Mismatch extends Error {}

function CheckRow({ icon: Icon, title, value, detail, run }: { icon: typeof Hash; title: string; value: string; detail: string; run?: () => Promise<string> }) {
  const [state, setState] = useState<{ busy?: boolean; ok?: string; mismatch?: string; failed?: string }>({});
  return (
    <div className="check-row">
      <span className="check-icon"><Icon /></span>
      <div className="check-body">
        <div className="check-title">
          <h4>{title}</h4>
          {state.ok && <span className="badge badge-green badge-dot">Matches</span>}
          {state.mismatch && <span className="badge badge-coral badge-dot">Mismatch</span>}
          {state.failed && <span className="badge badge-amber badge-dot">Could not verify</span>}
        </div>
        <div className="hash-line"><code className="mono break">{value}</code><CopyButton text={value} label={`Copy ${title}`} /></div>
        <p className="muted small">{state.ok ?? state.mismatch ?? (state.failed ? `${state.failed} Nothing was compared; try again.` : detail)}</p>
      </div>
      {run && (
        <button type="button" className="btn btn-sm" disabled={state.busy} onClick={async () => {
          setState({ busy: true });
          try {
            setState({ ok: await run() });
          } catch (error) {
            setState(error instanceof Mismatch ? { mismatch: error.message } : { failed: `Could not run the check: ${(error as Error).message}.` });
          }
        }}>{state.busy && <span className="spinner" aria-hidden="true" />}{state.ok ? <><Check /> Checked</> : state.failed ? "Try again" : "Check"}</button>
      )}
    </div>
  );
}

function VerifyTab({ detail }: { detail: ChallengeDetail }) {
  const { view } = detail;
  return (
    <div className="verify">
      <p className="text-2 tab-intro">The contract records a verdict only if it names these exact rules, this candidate and this test set. Check the commitments here, in your browser, against the chain.</p>
      <CheckRow icon={Hash} title="Rules" value={view.rules_sha256} detail="SHA-256 of the rules the contract serves, gates included." run={async () => {
        const actual = await sha256Hex(view.rules_json);
        if (actual !== view.rules_sha256) throw new Mismatch(`The served rules hash to ${actual}, not the commitment.`);
        return "The rules the contract serves hash to its commitment.";
      }} />
      <CheckRow icon={Cube} title="Evaluator build" value={view.evaluator.sha256} detail="OutLayer runs this exact WebAssembly build. The check downloads it and hashes it." run={async () => {
        const response = await fetch(view.evaluator.url);
        if (!response.ok) throw new Error(`the download failed with HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const actual = await sha256Hex(bytes);
        if (actual !== view.evaluator.sha256) throw new Mismatch(`The download hashes to ${actual}, not the pinned build.`);
        return `The ${(bytes.byteLength / 1024).toFixed(0)} KB build at its URL is the pinned one.`;
      }} />
      <CheckRow icon={Lock} title="Sealed test set" value={view.test_set_sha256} detail="Secret by design: only the hash is public. Each verdict carries the hash of the set it scored, and the contract rejects any that differs." />
    </div>
  );
}

function FindConfig({ evaluations, onFound }: { evaluations: EvaluationView[]; onFound: (ids: Set<number>) => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="find-config">
      <h4>Find a submission by its config</h4>
      <p className="muted small">Every verdict records the SHA-256 of the config it scored. Paste a config to find its evaluations.</p>
      <textarea className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"version": 1, "model": "…", …}' spellCheck={false} aria-label="Candidate config" />
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={async () => {
          // Pasting often drops or adds the file's final newline.
          const variants = [text, `${text.replace(/\n+$/, "")}\n`, text.replace(/\n+$/, "")];
          const hashes = new Set(await Promise.all(variants.map((v) => sha256Hex(v))));
          const ids = new Set(evaluations.filter((e) => hashes.has(e.config_sha256)).map((e) => e.id));
          setResult(ids.size ? `Matches evaluation ${[...ids].join(", ")}.` : "No evaluation was scored on this config.");
          onFound(ids);
          document.getElementById(`evaluation-${[...ids][0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}>Find</button>
        {result && <span className={`outcome ${result.startsWith("Matches") ? "ok" : "error"}`}>{result}</span>}
      </div>
    </div>
  );
}

function CompeteTab({ detail }: { detail: ChallengeDetail }) {
  const open = displayStatus(detail.view) === "open";
  return (
    <div className="compete">
      <p className="text-2 tab-intro">
        {open
          ? "Compete with your own agent through the Bakeoff MCP server. It reads these rules, scores candidates on the public practice set with this challenge's evaluator build, and submits when you approve."
          : "This challenge is not taking submissions. Its practice set and verdicts stay public, and the MCP server can still score candidates against it."}
      </p>
      <ol className="compete-steps">
        <li><span className="mono">1</span><div><h4>Build the server</h4><CodeBlock code={"git clone https://github.com/successaje/bakeoff\ncd bakeoff/mcp && npm ci && npm run build"} /></div></li>
        <li><span className="mono">2</span><div><h4>Add it to Claude Code</h4><CodeBlock code={`claude mcp add bakeoff \\\n  -e BAKEOFF_ACCOUNT=<your ${detail.network} account> \\\n  -- "$PWD/scripts/serve-local.sh"`} /></div></li>
        <li><span className="mono">3</span><div><h4>Ask your agent</h4><CodeBlock code={`Compete in the Bakeoff challenge ${detail.listing.id}. Read the rules and the labeling guide, find the cheapest candidate that clears every gate on the practice set with margin, and ask me before you submit.`} /></div></li>
      </ol>
      <div className="row">
        <Link to="/agents" className="btn">Full agent guide <ArrowRight /></Link>
        <span className="muted small">A submission costs 0.035 NEAR plus gas, most of it refunded. Its config becomes public on-chain.</span>
      </div>
    </div>
  );
}

export function Challenge() {
  const { id = "" } = useParams();
  const session = useSession();
  const reduced = usePrefersReducedMotion();
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useAsync(() => loadChallenge(id, version > 0), `${id}:${version}`);
  const [tab, setTab] = useState<Tab>("verdicts");
  const [highlight, setHighlight] = useState<Set<number>>(new Set());
  const refresh = () => {
    forget(id);
    setVersion((v) => v + 1);
  };
  // A challenge's network follows from its account name.
  useEffect(() => {
    if (data && data.network !== session.network) session.setNetwork(data.network);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.network]);

  const best = useMemo(() => (data ? bestRun(data) : null), [data]);
  const [readAt, setReadAt] = useState<Date | null>(null);
  useEffect(() => {
    if (data) setReadAt(new Date());
  }, [data]);
  // A result still scoring updates on its own; anything else on request.
  const pending = data?.view.pending ?? 0;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, id]);

  if (!data) {
    if (error && !loading) {
      // No such account, or an account that is not a challenge contract.
      return /UNKNOWN_ACCOUNT|does not exist|MethodNotFound|CodeDoesNotExist|wasm execution failed/.test(error.message) ? <NotFound what="challenge" /> : (
        <div className="container page-body"><p className="coral">Could not read {id}: {error.message}</p></div>
      );
    }
    return (
      <div className="container page-body">
        <div className="skeleton" style={{ height: 28, width: 220, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 56, width: "60%", marginBottom: 32 }} />
        <div className="skeleton skeleton-card" />
      </div>
    );
  }

  const { view, listing, network } = data;
  const gates = challengeGates(view);
  const award = view.award;
  const cut = costCut(listing.baseline, data.winner);
  const closes = nsToDate(view.closes_at);
  const status = displayStatus(view);

  return (
    <div className="page challenge-page">
      <div className="page-hero grid-bg-wrap">
        <div className="grid-bg page-grid" aria-hidden="true" />
        <div className="container">
          <Link to="/challenges" className="back-link">← Challenges</Link>
          <div className="challenge-head">
            <motion.div initial={reduced ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
              <div className="challenge-meta">
                <span className="eyebrow-plain">{listing.sponsor}</span>
                <StatusBadge view={view} />
                <span className="badge">{network}</span>
                {listing.demo && <DemoBadge />}
              </div>
              <h1 className="page-title">{listing.title}</h1>
              <p className="page-lede">{listing.summary}</p>
              <div className="contract-line">
                <span className="muted small">Contract</span>
                <a className="mono small break" href={explorer(network, "address", listing.id)} target="_blank" rel="noopener noreferrer">{listing.id}</a>
                <CopyButton text={listing.id} label="Copy contract account" />
              </div>
            </motion.div>
            <motion.aside className="bounty-card card" initial={reduced ? false : { opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.7, delay: 0.1 }}>
              <span className="label"><Coins /> {award ? (award.paid ? "Bounty paid" : "Bounty awarded") : "Bounty in escrow"}</span>
              <strong className="bounty-amount amber">{formatNear(award?.amount ?? view.bounty ?? "0")}</strong>
              <div className="bounty-rows">
                <div><span className="muted"><Timer /> {status === "open" ? "Closes in" : "Deadline"}</span><span>{status === "open" ? <Countdown closesAt={view.closes_at} /> : closes ? utc(closes) : "Set when it opens"}</span></div>
                <div><span className="muted">Verdicts</span><span className="tabular">{view.evaluations}{view.pending ? ` · ${view.pending} scoring` : ""}</span></div>
                <div><span className="muted">Sealed tickets</span><span className="tabular">{listing.tickets || "–"}</span></div>
              </div>
              {award ? (
                <div className="bounty-winner">
                  <span className="muted small">Won by</span>
                  <Account id={award.winner} network={network} />
                  {cut !== null && cut > 0 && <span className="badge badge-green">{cut}% cheaper than baseline</span>}
                </div>
              ) : status === "open" ? (
                <button type="button" className="btn btn-primary" onClick={() => { setTab("compete"); document.getElementById("tabs")?.scrollIntoView({ behavior: "smooth" }); }}>Compete for it <ArrowRight /></button>
              ) : null}
            </motion.aside>
          </div>
        </div>
      </div>

      <div className="container page-body">
        {listing.demo && <DemoNotice sponsor={listing.sponsor} network={network} />}

        {award?.paid && data.winner && (
          <Reveal className="award-callout">
            <span className="award-glow" aria-hidden="true" />
            <Check />
            <p>
              <strong>{award.winner}</strong> cleared every gate with evaluation {award.evaluation} — {percent(data.winner.accuracy_bp)} accuracy at {microDollars(data.winner.cost_per_ticket_uusd)} a ticket — and the contract paid {formatNear(award.amount)} with the verdict.
            </p>
          </Reveal>
        )}
        {award && !award.paid && (
          <Reveal className="award-callout pending">
            <Timer />
            <p>
              <strong>{award.winner}</strong> won the {formatNear(award.amount)} bounty with evaluation {award.evaluation}.{" "}
              {award.in_flight ? "The payment is on its way." : "The payment has not completed yet; anyone can retry it from the Sponsor tab."}
            </p>
          </Reveal>
        )}

        {gates && (
          <Reveal className="card card-pad bar-card">
            <div className="card-title-row">
              <div>
                <h2>The bar</h2>
                <p className="muted small">A candidate must clear every gate on the {listing.tickets || ""} sealed tickets. The gates are the contract's rules; the baseline is the figure {listing.sponsor} published, not one the contract measured.</p>
              </div>
              <div className="legend">
                <span><i className="legend-baseline" /> Baseline</span>
                <span><i className="legend-gate" /> Gate</span>
                {best?.metrics && <span><i className="legend-best" /> {best.label}</span>}
              </div>
            </div>
            <TheBar gates={gates} baseline={listing.baseline} best={best?.metrics ?? null} bestLabel={best?.label ?? ""} />
          </Reveal>
        )}

        <div className="freshness" aria-live="polite">
          <span className="muted small">
            {loading ? "Reading the contract…" : readAt ? <>Read from {network} at {readAt.toISOString().slice(11, 19)} UTC{pending ? ` · ${pending} result${pending > 1 ? "s" : ""} scoring, updating every 10 s` : ""}</> : null}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>{loading && <span className="spinner" aria-hidden="true" />}Refresh</button>
        </div>

        <div id="tabs" className="tabs-wrap">
          <Tabs
            tabs={[
              { id: "verdicts", label: "Verdicts", count: data.evaluations.length },
              { id: "verify", label: "Verify" },
              { id: "compete", label: "Compete" },
              { id: "sponsor", label: "Sponsor" },
            ]}
            value={tab}
            onChange={setTab}
          />
          {/* Slide only: a fade that stalls (in a background tab, say) would leave the panel invisible. */}
          <motion.div key={tab} className="card card-pad tab-panel" initial={reduced ? false : { y: 8 }} animate={{ y: 0 }} transition={{ duration: 0.3 }}>
            <ErrorBoundary>
              {tab === "verdicts" && (
                <>
                  <VerdictTable evaluations={data.evaluations} network={network} awarded={award?.evaluation ?? null} highlight={highlight} />
                  <hr className="divider" />
                  <FindConfig evaluations={data.evaluations} onFound={setHighlight} />
                </>
              )}
              {tab === "verify" && <VerifyTab detail={data} />}
              {tab === "compete" && <CompeteTab detail={data} />}
              {tab === "sponsor" && <SponsorPanel id={id} network={network} view={view} rpc={rpcFor(network)} onChanged={refresh} />}
            </ErrorBoundary>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
