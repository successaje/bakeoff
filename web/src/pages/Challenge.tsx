/**
 * A challenge, told in the order a visitor asks about it: the problem, the
 * goal, how solutions are tested, the results, how to take part, and how to
 * check it all. The owner's controls sit in their own Manage section.
 */

import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { costCut, ResultsTable, TheBar } from "../components/challenge.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { ArrowRight, Check, Coins, Cube, Hash, Lock, Timer } from "../components/Icons.tsx";
import { ManagePanel, RetryPayment } from "../components/Manage.tsx";
import { Account, CodeBlock, CopyButton, Countdown, DemoBadge, DemoNotice, displayStatus, explorer, Reveal, StatusBadge } from "../components/ui.tsx";
import { type ChallengeDetail, forget, loadChallenge, rpcFor } from "../lib/data.ts";
import { microDollars, percent, seconds, utc } from "../lib/format.ts";
import { challengeGates, type EvaluationView, formatNear, type Gates, type Metrics, nsToDate, sha256Hex, verdictMetrics } from "../lib/near.ts";
import type { Baseline } from "../lib/registry.ts";
import { useAsync, usePrefersReducedMotion } from "../lib/hooks.ts";
import { useSession } from "../lib/session.tsx";
import { NotFound } from "./NotFound.tsx";

/** The winner's metrics, else the best passing run, else nothing to plot. */
function bestRun(detail: ChallengeDetail): { metrics: Metrics | null; label: string } {
  if (detail.winner) return { metrics: detail.winner, label: "Winner" };
  const passed = detail.evaluations.filter((e) => e.status === "Passed").map(verdictMetrics).filter((m): m is Metrics => m !== null);
  passed.sort((a, b) => (b.accuracy_bp ?? 0) - (a.accuracy_bp ?? 0));
  return { metrics: passed[0] ?? null, label: "Best pass" };
}

/** The requirements as one sentence a team would say. */
function goalSentence(gates: Gates, baseline: Baseline): string {
  const parts: string[] = [];
  const cut = baseline.cost_per_ticket_uusd ? Math.round((1 - gates.max_cost_per_ticket_uusd / baseline.cost_per_ticket_uusd) * 100) : 0;
  parts.push(cut > 0
    ? `cut the cost per ticket by at least ${cut}%, to ${microDollars(gates.max_cost_per_ticket_uusd)} or less`
    : `keep the cost per ticket at ${microDollars(gates.max_cost_per_ticket_uusd)} or less`);
  parts.push(`keep accuracy at ${percent(gates.min_accuracy_bp)} or more`);
  parts.push(`answer 19 tickets in 20 within ${seconds(gates.max_p95_latency_ms)}`);
  if (gates.max_leaks === 0) parts.push("never repeat a card number");
  const sentence = `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
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

function Verification({ detail }: { detail: ChallengeDetail }) {
  const { view } = detail;
  return (
    <div className="verify">
      <p className="text-2 tab-intro">The contract records a result only if it names these exact rules, this solution and this test set. Check the commitments here, in your browser, against the chain.</p>
      <CheckRow icon={Hash} title="Rules" value={view.rules_sha256} detail="SHA-256 of the rules the contract serves, requirements included." run={async () => {
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
      <CheckRow icon={Lock} title="Hidden test set" value={view.test_set_sha256} detail="Only the hash is public. Each result carries the hash of the set it was scored on, and the contract rejects any that differs." />
    </div>
  );
}

function FindConfig({ evaluations, onFound }: { evaluations: EvaluationView[]; onFound: (ids: Set<number>) => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="find-config">
      <h4>Find a result by its config</h4>
      <p className="muted small">Every result records the SHA-256 of the config it scored. Paste a config to find its results.</p>
      <textarea className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"version": 1, "model": "…", …}' spellCheck={false} aria-label="Solution config" />
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={async () => {
          // Pasting often drops or adds the file's final newline.
          const variants = [text, `${text.replace(/\n+$/, "")}\n`, text.replace(/\n+$/, "")];
          const hashes = new Set(await Promise.all(variants.map((v) => sha256Hex(v))));
          const ids = new Set(evaluations.filter((e) => hashes.has(e.config_sha256)).map((e) => e.id));
          setResult(ids.size ? `Matches result ${[...ids].map((i) => `#${i}`).join(", ")}.` : "No result was scored on this config.");
          onFound(ids);
          document.getElementById(`evaluation-${[...ids][0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}>Find</button>
        {result && <span className={`outcome ${result.startsWith("Matches") ? "ok" : "error"}`}>{result}</span>}
      </div>
    </div>
  );
}

function TakePart({ detail }: { detail: ChallengeDetail }) {
  const open = displayStatus(detail.view) === "open";
  return (
    <div className="compete">
      <p className="text-2 tab-intro">
        {open
          ? "Builders take part through the Bakeoff MCP server, with Claude Code, Codex or any MCP client. Your agent reads the rules, scores solutions on the practice tickets with this challenge's evaluator, and submits when you approve."
          : "This challenge is not taking submissions. Its practice tickets and results stay public, and the MCP server can still score solutions against it."}
      </p>
      <ol className="compete-steps">
        <li><span className="mono">1</span><div><h4>Build the server</h4><CodeBlock code={"git clone https://github.com/successaje/bakeoff\ncd bakeoff/mcp && npm ci && npm run build"} /></div></li>
        <li><span className="mono">2</span><div><h4>Add it to Claude Code</h4><CodeBlock code={`claude mcp add bakeoff \\\n  -e BAKEOFF_ACCOUNT=<your ${detail.network} account> \\\n  -e BAKEOFF_NETWORK=${detail.network} \\\n  -e BAKEOFF_CHALLENGES=${detail.listing.id} \\\n  -- "$PWD/scripts/serve-local.sh"`} /></div></li>
        <li><span className="mono">3</span><div><h4>Ask your agent</h4><CodeBlock code={`Compete in the Bakeoff challenge ${detail.listing.id}. Read the rules and the labeling guide, find the cheapest solution that meets every requirement on the practice tickets with margin, and ask me before you submit.`} /></div></li>
      </ol>
      <div className="row">
        <Link to="/builders" className="btn">Full guide for builders <ArrowRight /></Link>
        <span className="muted small">A submission costs 0.035 NEAR plus gas, most of it refunded. Its config becomes public on-chain.</span>
      </div>
    </div>
  );
}

const SECTIONS = [
  { id: "problem", label: "Problem" },
  { id: "goal", label: "Goal" },
  { id: "testing", label: "How it's tested" },
  { id: "results", label: "Results" },
  { id: "take-part", label: "Take part" },
  { id: "verification", label: "Verification" },
];

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="story-section" aria-labelledby={`${id}-title`}>
      <div className="story-head">
        <h2 id={`${id}-title`}>{title}</h2>
        {intro && <p className="text-2">{intro}</p>}
      </div>
      <ErrorBoundary>{children}</ErrorBoundary>
    </section>
  );
}

export function Challenge() {
  const { id = "" } = useParams();
  const location = useLocation();
  const session = useSession();
  const reduced = usePrefersReducedMotion();
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useAsync(() => loadChallenge(id, version > 0), `${id}:${version}`);
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
  // Links such as "All results" name a section to open at.
  const loaded = data !== null;
  useEffect(() => {
    const section = location.hash.replace(/^#/, "");
    if (loaded && section) requestAnimationFrame(() => scrollToSection(section));
  }, [loaded, location.hash]);

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
  const isOwner = session.account === view.owner;
  const sections = isOwner ? [{ id: "manage", label: "Manage" }, ...SECTIONS] : SECTIONS;
  const winningResult = award ? `/challenges/${id}/results/${award.evaluation}` : null;

  return (
    <div className="page challenge-page">
      <div className="page-hero grid-bg-wrap">
        <div className="grid-bg page-grid" aria-hidden="true" />
        <div className="container">
          <Link to="/challenges" className="back-link">← Challenges</Link>
          <div className="challenge-head">
            <motion.div initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
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
            <motion.aside className="bounty-card card" initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}>
              <span className="label"><Coins /> {award ? (award.paid ? "Reward paid" : "Reward won, not yet paid") : "Reward held by the contract"}</span>
              <strong className="bounty-amount amber">{formatNear(award?.amount ?? view.bounty ?? "0")}</strong>
              <div className="bounty-rows">
                <div><span className="muted"><Timer /> {status === "open" ? "Closes in" : "Deadline"}</span><span>{status === "open" ? <Countdown closesAt={view.closes_at} /> : closes ? utc(closes) : "Set when it opens"}</span></div>
                <div><span className="muted">Results</span><span className="tabular">{view.evaluations}{view.pending ? ` · ${view.pending} scoring` : ""}</span></div>
                <div><span className="muted">Hidden test tickets</span><span className="tabular">{listing.tickets || "–"}</span></div>
              </div>
              {award && (
                <div className="bounty-winner">
                  <span className="muted small">Won by</span>
                  <Account id={award.winner} network={network} />
                  {cut !== null && cut > 0 && <span className="badge badge-green">{cut}% cheaper than baseline</span>}
                </div>
              )}
              {winningResult ? (
                <Link to={winningResult} className="btn btn-primary">See the winning result <ArrowRight /></Link>
              ) : status === "open" ? (
                <button type="button" className="btn btn-primary" onClick={() => scrollToSection("take-part")}>Take part <ArrowRight /></button>
              ) : status === "draft" ? (
                <p className="muted small">Opens to builders once the owner funds and opens it.</p>
              ) : (
                <button type="button" className="btn" onClick={() => scrollToSection("results")}>See the results <ArrowRight /></button>
              )}
              {isOwner && <button type="button" className="btn btn-ghost btn-sm" onClick={() => scrollToSection("manage")}>Manage challenge</button>}
            </motion.aside>
          </div>
        </div>
      </div>

      <nav className="story-nav" aria-label="On this page">
        <div className="container story-nav-inner">
          {sections.map((s) => (
            <button key={s.id} type="button" onClick={() => scrollToSection(s.id)}>
              {s.label}{s.id === "results" && view.evaluations > 0 && <span className="tab-count">{view.evaluations}</span>}
            </button>
          ))}
        </div>
      </nav>

      <div className="container page-body story">
        {listing.demo && <DemoNotice sponsor={listing.sponsor} network={network} />}

        {award?.paid && data.winner && (
          <Reveal className="award-callout">
            <span className="award-glow" aria-hidden="true" />
            <Check />
            <p>
              <strong>{award.winner}</strong> met every requirement with result #{award.evaluation} ({percent(data.winner.accuracy_bp)} accuracy at {microDollars(data.winner.cost_per_ticket_uusd)} a ticket), and the contract paid {formatNear(award.amount)} with the result.{" "}
              <Link to={winningResult!}>See the result</Link>
            </p>
          </Reveal>
        )}
        {award && !award.paid && (
          <Reveal className="award-callout pending">
            <Timer />
            <div>
              <p>
                <strong>{award.winner}</strong> won the {formatNear(award.amount)} reward with result #{award.evaluation}.{" "}
                {award.in_flight ? "The payment is on its way." : "The payment has not completed yet. Any connected wallet can retry it; the contract pays only the winner."}
              </p>
              <RetryPayment id={id} award={award} onChanged={refresh} />
            </div>
          </Reveal>
        )}

        {isOwner && (
          <Section id="manage" title="Manage challenge" intro={<>You are connected as the owner, <strong className="break">{view.owner}</strong>. Only you see this section.</>}>
            <div className="card card-pad">
              <ManagePanel id={id} network={network} view={view} rpc={rpcFor(network)} onChanged={refresh} />
            </div>
          </Section>
        )}

        <Section id="problem" title="The problem" intro={`What ${listing.sponsor}'s workflow does today, in its own words and figures.`}>
          <div className="problem card card-pad">
            <p className="problem-text">{listing.problem ?? listing.summary}</p>
            {listing.baseline.accuracy_bp > 0 && (
              <dl className="today">
                <div><dt>Accuracy today</dt><dd>{percent(listing.baseline.accuracy_bp)}</dd></div>
                <div><dt>Cost per ticket</dt><dd>{microDollars(listing.baseline.cost_per_ticket_uusd)}</dd></div>
                <div><dt>p95 latency</dt><dd>{seconds(listing.baseline.p95_latency_ms)}</dd></div>
              </dl>
            )}
            <p className="muted small">Figures published by {listing.sponsor} for its current agent. The contract does not measure them.</p>
          </div>
        </Section>

        {gates && (
          <Section id="goal" title="The goal" intro={goalSentence(gates, listing.baseline)}>
            <div className="card card-pad bar-card">
              <div className="card-title-row">
                <p className="muted small">A solution must meet every requirement on the {listing.tickets || ""} hidden tickets. The requirements are the contract's rules.</p>
                <div className="legend">
                  <span><i className="legend-baseline" /> Baseline</span>
                  <span><i className="legend-gate" /> Needed</span>
                  {best?.metrics && <span><i className="legend-best" /> {best.label}</span>}
                </div>
              </div>
              <TheBar gates={gates} baseline={listing.baseline} best={best?.metrics ?? null} bestLabel={best?.label ?? ""} />
            </div>
          </Section>
        )}

        <Section id="testing" title="How it's tested" intro="Builders tune in the open and are scored in private, once, on tickets they never see.">
          <div className="compare">
            <div className="card card-pad compare-col">
              <h3>Builders can see</h3>
              <ul className="check-list">
                <li>The rules and requirements, as the contract stores them</li>
                <li>{listing.practice_tickets ? `${listing.practice_tickets} practice tickets` : "Practice tickets"} with their labels</li>
                <li>The labelling guide every ticket follows</li>
                <li>The evaluator build, to score solutions on practice tickets</li>
              </ul>
            </div>
            <div className="card card-pad compare-col">
              <h3><Lock /> Hidden from builders</h3>
              <ul className="check-list">
                <li>{listing.tickets ? `${listing.tickets} test tickets` : "The test tickets"} and their labels</li>
                <li>The owner's model API key</li>
                <li>Every per-ticket answer from the test</li>
              </ul>
            </div>
          </div>
          <p className="muted small story-note">
            Each submission is scored once, inside an OutLayer enclave, on the hidden tickets; only totals and hashes come out. The tickets are sent to the model on NEAR AI Cloud to be answered. <Link to="/how-it-works">What you still have to trust</Link>
          </p>
        </Section>

        <Section id="results" title="Results" intro="Every submission's outcome, as the contract recorded it. Open one to see what changed and how to use it.">
          <div className="freshness" aria-live="polite">
            <span className="muted small">
              {loading ? "Reading the contract…" : readAt ? <>Read from {network} at {readAt.toISOString().slice(11, 19)} UTC{pending ? ` · ${pending} result${pending > 1 ? "s" : ""} scoring, updating every 10 s` : ""}</> : null}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>{loading && <span className="spinner" aria-hidden="true" />}Refresh</button>
          </div>
          <div className="card card-pad">
            <ResultsTable challenge={id} evaluations={data.evaluations} network={network} awarded={award?.evaluation ?? null} highlight={highlight} />
            <hr className="divider" />
            <FindConfig evaluations={data.evaluations} onFound={setHighlight} />
          </div>
        </Section>

        <Section id="take-part" title="Take part">
          <div className="card card-pad"><TakePart detail={data} /></div>
        </Section>

        <Section id="verification" title="Rules and verification">
          <div className="card card-pad"><Verification detail={data} /></div>
        </Section>

        {!session.account && (
          <p className="muted small owner-hint">
            Own this challenge? <button type="button" className="link-button" onClick={() => void session.signIn()}>Connect the owner's wallet</button> to fund, open or withdraw it.
          </p>
        )}
      </div>
    </div>
  );
}
