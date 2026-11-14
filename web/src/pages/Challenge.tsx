/**
 * A challenge, as a competition page: the host and the main action on top,
 * then tabs. Overview tells the problem, the goal, how it's tested and the
 * timeline, beside the facts a visitor scans for; Data shows the practice
 * set; Leaderboard ranks the builders; Rules holds the requirements and the
 * checks against the chain; Take part shows how to compete. The owner's
 * controls get their own tab.
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useParams } from "react-router";
import { Avatar, Cover, HostMark } from "../components/art.tsx";
import { StatusChip } from "../components/board.tsx";
import { ChallengeLeaderboard } from "../components/ChallengeLeaderboard.tsx";
import { costCut, TheBar } from "../components/challenge.tsx";
import { DataExplorer } from "../components/DataExplorer.tsx";
import { ErrorBoundary, ErrorNotice } from "../components/ErrorBoundary.tsx";
import { ArrowRight, Check, Coins, Copy, Cube, External, Hash, Lock, More, Replay, Shield, Timer } from "../components/Icons.tsx";
import { ManagePanel, RetryPayment } from "../components/Manage.tsx";
import { CodeBlock, CopyButton, Countdown, DemoBadge, DemoNotice, displayStatus, explorer, Reveal } from "../components/ui.tsx";
import { type ChallengeDetail, forget, loadChallenge, rpcFor } from "../lib/data.ts";
import { microDollars, percent, seconds, utc } from "../lib/format.ts";
import { useAsync, usePrefersReducedMotion } from "../lib/hooks.ts";
import { challengeGates, type EvaluationView, formatNear, type Gates, isMissingAccount, type Metrics, nsToDate, sha256Hex, verdictMetrics } from "../lib/near.ts";
import type { Baseline } from "../lib/registry.ts";
import { useSession } from "../lib/session.tsx";
import { NotFound } from "./NotFound.tsx";

type Tab = "overview" | "data" | "leaderboard" | "rules" | "take-part" | "manage";
const TABS: Tab[] = ["overview", "data", "leaderboard", "rules", "take-part", "manage"];

/** Sections of the earlier one-page layout, so links already shared still land. */
const LEGACY: Record<string, { tab: Tab; section?: string }> = {
  problem: { tab: "overview", section: "problem" },
  goal: { tab: "overview", section: "goal" },
  testing: { tab: "overview", section: "testing" },
  results: { tab: "leaderboard" },
  "take-part": { tab: "take-part" },
  verification: { tab: "rules", section: "verification" },
  manage: { tab: "manage" },
};

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

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
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

/** How many access keys the challenge account still has; none means its code is locked. */
function useKeys(detail: ChallengeDetail) {
  const id = detail.listing.id;
  return useAsync(() => rpcFor(detail.network).accessKeys(id), `keys:${detail.network}:${id}`);
}

/** Whether the challenge account still has keys that could replace its code. */
function LockRow({ detail }: { detail: ChallengeDetail }) {
  const id = detail.listing.id;
  const keys = useKeys(detail);
  const count = keys.data?.length;
  const plural = count === 1 ? "key" : "keys";
  return (
    <div className="check-row">
      <span className="check-icon"><Shield /></span>
      <div className="check-body">
        <div className="check-title">
          <h4>Contract code</h4>
          {count === 0 && <span className="badge badge-green badge-dot">Locked · 0 keys</span>}
          {count !== undefined && count > 0 && <span className="badge badge-amber badge-dot">Not locked · {count} {plural}</span>}
          {keys.error && !keys.data && <span className="badge badge-amber badge-dot">Could not verify</span>}
        </div>
        <div className="hash-line"><code className="mono break">{id}</code><CopyButton text={id} label="Copy the challenge account" /></div>
        <p className="muted small">
          {count === 0
            ? "The challenge account has no access keys, read from the chain as this page loaded. Nobody, its deployer included, can change this contract's code or sign as it."
            : count
              ? `The challenge account still has ${count} access ${plural}. Whoever holds ${count === 1 ? "it" : "them"} could deploy different code to this contract; scripts/near/lock.sh deletes ${count === 1 ? "it" : "them"}.`
              : keys.error
                ? `Could not read the account's keys: ${keys.error.message}.`
                : "Reading the account's keys…"}
        </p>
      </div>
    </div>
  );
}

function Verification({ detail }: { detail: ChallengeDetail }) {
  const { view } = detail;
  return (
    <div className="verify">
      <p className="text-2 tab-intro">The contract records a result only if it names these exact rules, this solution and this test set. Check the commitments here, in your browser, against the chain, and whether the contract's code can still change.</p>
      <LockRow detail={detail} />
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
      <hr className="divider" />
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
          : "This challenge is not taking submissions. Its practice tickets and leaderboard stay public, and the MCP server can still score solutions against it."}
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

/** A titled part of a tab, with a link to it and a way to fold it away. */
function DocSection({ id, title, children, intro }: { id: string; title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="doc-section folding" id={id} open>
      <summary>
        <h2>{title}</h2>
        <button type="button" className="icon-btn doc-link" aria-label={copied ? "Link copied" : `Copy a link to ${title}`} title={copied ? "Link copied" : "Copy link"} onClick={(event) => {
          event.preventDefault();
          void navigator.clipboard?.writeText(`${location.href.split("#").slice(0, 2).join("#")}#${id}`).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}>{copied ? <Check /> : <Copy />}</button>
        <span className="doc-fold" aria-hidden="true" />
      </summary>
      <div className="doc-body">
        {intro && <p className="text-2 doc-intro">{intro}</p>}
        <ErrorBoundary>{children}</ErrorBoundary>
      </div>
    </details>
  );
}

function Timeline({ detail }: { detail: ChallengeDetail }) {
  const { view, evaluations } = detail;
  const times = (pick: (e: EvaluationView) => string | null) => evaluations.map((e) => nsToDate(pick(e))).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime());
  const first = times((e) => e.requested_at)[0];
  const latest = times((e) => e.settled_at).at(-1);
  const winning = view.award ? evaluations.find((e) => e.id === view.award!.evaluation) : undefined;
  const closes = nsToDate(view.closes_at);
  const items = [
    first && { at: first, label: "First submission", text: "The first result was requested." },
    winning?.settled_at && { at: nsToDate(winning.settled_at)!, label: view.award!.paid ? "Reward paid" : "Reward won", text: `Result #${winning.id} met every requirement${view.award!.paid ? `, and the contract paid ${formatNear(view.award!.amount)} with it` : ""}.` },
    latest && latest !== first && { at: latest, label: "Latest result", text: "The most recent result was recorded." },
    closes && { at: closes, label: closes.getTime() > Date.now() ? "Deadline" : "Deadline passed", text: closes.getTime() > Date.now() ? "Submissions close. One made before then can still win after it." : "No new submissions are accepted." },
  ].filter((x): x is { at: Date; label: string; text: string } => !!x).sort((a, b) => a.at.getTime() - b.at.getTime());
  if (items.length === 0) return <p className="muted small">Nothing has happened yet. The timeline starts when the owner opens the challenge.</p>;
  const now = Date.now();
  return (
    <ol className="timeline">
      {items.map((item) => (
        <li key={item.label} className={item.at.getTime() > now ? "future" : ""}>
          <span className="timeline-dot" aria-hidden="true" />
          <div><strong>{item.label}</strong> <span className="muted small mono">{utc(item.at)}</span><p className="text-2 small">{item.text}</p></div>
        </li>
      ))}
    </ol>
  );
}

function Sidebar({ detail, sections }: { detail: ChallengeDetail; sections: { id: string; label: string }[] }) {
  const { view, listing, network, evaluations } = detail;
  const keys = useKeys(detail);
  const award = view.award;
  const builders = new Set(evaluations.filter((e) => e.eligible !== false && e.submitter !== view.owner).map((e) => e.submitter)).size;
  const passed = evaluations.filter((e) => e.status === "Passed").length;
  const status = displayStatus(view);
  return (
    <aside className="cx-side">
      <div className="side-block">
        <h4>Challenge host</h4>
        <div className="side-host"><HostMark name={listing.sponsor} size={34} /><div><strong>{listing.sponsor}</strong><Link to={`/accounts/${view.owner}`} className="muted small break">{view.owner}</Link></div></div>
      </div>
      <div className="side-block">
        <h4>Reward</h4>
        <p className="side-reward"><Coins /> {formatNear(award?.amount ?? view.bounty ?? "0")}</p>
        <p className="muted small">{award ? (award.paid ? <>Paid to <Link to={`/accounts/${award.winner}`}>{award.winner}</Link></> : "Won, payment pending") : status === "open" ? "Held by the contract until a result meets every requirement" : status === "draft" ? "Escrowed when the owner opens it" : "Returned to the owner if nobody wins"}</p>
        {status === "open" && <p className="small"><Timer /> <Countdown closesAt={view.closes_at} /></p>}
      </div>
      <div className="side-block">
        <h4>Participation</h4>
        <dl className="side-stats">
          <div><dt>Builders</dt><dd>{builders}</dd></div>
          <div><dt>Results</dt><dd>{evaluations.length}</dd></div>
          <div><dt>Met every requirement</dt><dd>{passed}</dd></div>
          {!!view.pending && <div><dt>Scoring now</dt><dd>{view.pending}</dd></div>}
        </dl>
      </div>
      <div className="side-block">
        <h4>Contract</h4>
        <div className="hash-line"><a className="mono small break" href={explorer(network, "address", listing.id)} target="_blank" rel="noopener noreferrer">{listing.id}</a><CopyButton text={listing.id} label="Copy the contract account" /></div>
        <p className="side-chips">
          <span className="chip chip-grey">{network}</span>
          {keys.data && (keys.data.length === 0 ? <span className="chip chip-green">Locked · 0 keys</span> : <span className="chip chip-amber">Not locked · {keys.data.length} {keys.data.length === 1 ? "key" : "keys"}</span>)}
        </p>
      </div>
      {listing.tags && listing.tags.length > 0 && (
        <div className="side-block">
          <h4>Tags</h4>
          <p className="side-chips">{listing.tags.map((t) => <span key={t} className="chip chip-grey">{t}</span>)}</p>
        </div>
      )}
      <nav className="side-block side-toc" aria-label="On this page">
        <h4>On this page</h4>
        {sections.map((s) => <button key={s.id} type="button" onClick={() => scrollToSection(s.id)}>{s.label}</button>)}
      </nav>
    </aside>
  );
}

function RequirementsTable({ gates, baseline }: { gates: Gates; baseline: Baseline }) {
  const rows = [
    { name: "Accuracy on the hidden tickets", needed: `≥ ${percent(gates.min_accuracy_bp)}`, base: baseline.accuracy_bp ? percent(baseline.accuracy_bp) : "–" },
    { name: "Cost per ticket", needed: `≤ ${microDollars(gates.max_cost_per_ticket_uusd)}`, base: baseline.cost_per_ticket_uusd ? microDollars(baseline.cost_per_ticket_uusd) : "–" },
    { name: "p95 latency", needed: `≤ ${seconds(gates.max_p95_latency_ms)}`, base: baseline.p95_latency_ms ? seconds(baseline.p95_latency_ms) : "–" },
    { name: "Card numbers repeated", needed: gates.max_leaks === 0 ? "None" : `≤ ${gates.max_leaks}`, base: "–" },
  ];
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Requirement</th><th className="num">Needed</th><th className="num">The team's baseline</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num">{r.needed}</td><td className="num muted">{r.base}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function RulesTab({ detail }: { detail: ChallengeDetail }) {
  const gates = challengeGates(detail.view);
  const rules = useMemo(() => {
    try {
      return JSON.parse(detail.view.rules_json) as { models?: Record<string, unknown>; allowed_tools?: string[]; allowed_request_options?: string[]; max_tokens_cap?: number; time_budget_ms?: number; max_concurrency?: number };
    } catch {
      return null;
    }
  }, [detail.view.rules_json]);
  return (
    <div className="tab-body">
      {gates && (
        <DocSection id="requirements" title="Requirements" intro="A result must meet all four on the hidden tickets. They are the contract's rules, frozen when the challenge opened.">
          <div className="card card-pad"><RequirementsTable gates={gates} baseline={detail.listing.baseline} /></div>
        </DocSection>
      )}
      <DocSection id="reward-rules" title="How the reward is won">
        <ul className="check-list">
          <li>The earliest-submitted result that meets every requirement wins, once every submission made before it has settled. A copied config is always submitted later than its original.</li>
          <li>The owner's own submissions are trial runs: recorded, never paid.</li>
          <li>A submission made before the deadline can still win after it.</li>
          <li>If nobody wins by the deadline, the owner can take the reward back.</li>
        </ul>
      </DocSection>
      {rules && (
        <DocSection id="what-you-can-change" title="What a solution can change">
          <dl className="config-facts rules-facts">
            <div><dt>Models</dt><dd className="mono">{Object.keys(rules.models ?? {}).join(", ") || "–"}</dd></div>
            <div><dt>Tools</dt><dd>{rules.allowed_tools?.length ? rules.allowed_tools.join(", ") : "None: no tool calls or webhooks"}</dd></div>
            <div><dt>Request options</dt><dd className="mono">{rules.allowed_request_options?.join(", ") || "–"}</dd></div>
            <div><dt>Most output tokens</dt><dd>{rules.max_tokens_cap ?? "–"}</dd></div>
            <div><dt>Time for the whole run</dt><dd>{rules.time_budget_ms ? seconds(rules.time_budget_ms) : "–"}</dd></div>
            <div><dt>Tickets in flight</dt><dd>{rules.max_concurrency ?? 8}</dd></div>
          </dl>
          <details className="raw-rules"><summary className="small">The rules as the contract stores them</summary><CodeBlock code={JSON.stringify(JSON.parse(detail.view.rules_json), null, 2)} label="Rules JSON" /></details>
        </DocSection>
      )}
      <DocSection id="verification" title="Verification">
        <div className="card card-pad"><Verification detail={detail} /></div>
      </DocSection>
    </div>
  );
}

function MoreMenu({ detail, isOwner, onRefresh }: { detail: ChallengeDetail; isOwner: boolean; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const id = detail.listing.id;
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="icon-btn" aria-label="More actions" aria-expanded={open} onClick={() => setOpen((o) => !o)}><More /></button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu-panel" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}>
            <button type="button" className="menu-item" onClick={() => { void navigator.clipboard?.writeText(id); setOpen(false); }}><Copy /> Copy contract account</button>
            <a className="menu-item" href={explorer(detail.network, "address", id)} target="_blank" rel="noopener noreferrer"><External /> View on explorer</a>
            <button type="button" className="menu-item" onClick={() => { onRefresh(); setOpen(false); }}><Replay /> Read the contract again</button>
            {isOwner && <Link className="menu-item" to={`/challenges/${id}/manage`} onClick={() => setOpen(false)}><Shield /> Manage challenge</Link>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PrimaryAction({ detail, compact = false }: { detail: ChallengeDetail; compact?: boolean }) {
  const { view, listing } = detail;
  const status = displayStatus(view);
  const size = compact ? "btn-sm" : "";
  if (view.award) return <Link to={`/challenges/${listing.id}/results/${view.award.evaluation}`} className={`btn btn-primary ${size}`}>See the winning result</Link>;
  if (status === "open") return <Link to={`/challenges/${listing.id}/take-part`} className={`btn btn-primary ${size}`}>Take part</Link>;
  if (status === "draft") return <button type="button" className={`btn ${size}`} disabled>Opens soon</button>;
  return <Link to={`/challenges/${listing.id}/leaderboard`} className={`btn ${size}`}>See the leaderboard</Link>;
}

/** True while the element is on screen; `ready` once it has rendered. */
function useOnScreen<T extends Element>(ready: boolean): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setOn(entry?.isIntersecting ?? true), { rootMargin: "-64px 0px 0px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready]);
  return [ref, on];
}

export function Challenge() {
  const { id = "", tab: tabParam } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const reduced = usePrefersReducedMotion();
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useAsync(() => loadChallenge(id, version > 0), `${id}:${version}`);
  const [highlight, setHighlight] = useState<Set<number>>(new Set());
  const [headRef, headOnScreen] = useOnScreen<HTMLDivElement>(data !== null);
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
  // A link may name a section: one of this tab's, or one of the earlier single page's.
  const loaded = data !== null;
  useEffect(() => {
    const section = location.hash.replace(/^#/, "");
    if (!loaded || !section) return;
    const legacy = LEGACY[section];
    if (legacy && !tabParam && legacy.tab !== "overview") {
      navigate(`/challenges/${id}/${legacy.tab}${legacy.section ? `#${legacy.section}` : ""}`, { replace: true });
      return;
    }
    requestAnimationFrame(() => scrollToSection(legacy?.section ?? section));
  }, [loaded, location.hash, tabParam, id, navigate]);

  if (!data) {
    if (error && !loading) {
      // No such account, or an account that is not a challenge contract; anything else is a read
      // that failed, and can be tried again.
      return isMissingAccount(error) ? <NotFound what="challenge" /> : (
        <div className="container page-body"><ErrorNotice error={new Error(`Could not read ${id} from NEAR: ${error.message}`)} onRetry={refresh} /></div>
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
  const isOwner = session.account === view.owner;
  const tab: Tab = TABS.includes(tabParam as Tab) && (tabParam !== "manage" || isOwner) ? (tabParam as Tab) : "overview";
  const cut = costCut(listing.baseline, data.winner);
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "data", label: "Data" },
    { id: "leaderboard", label: "Leaderboard", count: view.evaluations },
    { id: "rules", label: "Rules" },
    { id: "take-part", label: "Take part" },
    ...(isOwner ? [{ id: "manage" as Tab, label: "Manage" }] : []),
  ];
  const overviewSections = [
    { id: "problem", label: "Overview" },
    ...(gates ? [{ id: "goal", label: "Goal" }] : []),
    { id: "testing", label: "How it's tested" },
    { id: "timeline", label: "Timeline" },
  ];
  const href = (t: Tab) => `/challenges/${id}${t === "overview" ? "" : `/${t}`}`;

  return (
    <div className="page challenge-page">
      <div className="container cx-head" ref={headRef}>
        <div className="cx-hostline">
          <HostMark name={listing.sponsor} size={30} />
          <span className="cx-hostline-text">{listing.sponsor} · AI workflow challenge · {network}</span>
          <StatusChip view={view} />
          {listing.demo && <DemoBadge />}
          <span className="cx-actions"><PrimaryAction detail={data} /><MoreMenu detail={data} isOwner={isOwner} onRefresh={refresh} /></span>
        </div>
        <motion.div className="cx-title" initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
          <div>
            <h1>{listing.title}</h1>
            <p className="text-2">{listing.summary}</p>
            {award && data.winner && (
              <p className="cx-winline">
                <Avatar id={award.winner} size={22} />
                <span><Link to={`/accounts/${award.winner}`}><strong>{award.winner}</strong></Link> won {formatNear(award.amount)} at {percent(data.winner.accuracy_bp)}{cut !== null && cut > 0 ? `, ${cut}% cheaper than the baseline` : ""}</span>
              </p>
            )}
          </div>
          <div className="cx-cover"><Cover id={listing.id} lit={data.winner?.accuracy_bp ? data.winner.accuracy_bp / 10_000 : 0.35} /></div>
        </motion.div>
      </div>

      <nav className={`cx-tabs ${headOnScreen ? "" : "stuck"}`} aria-label="Challenge">
        <div className="container cx-tabs-inner">
          <span className="cx-tabs-title" aria-hidden={headOnScreen}>{listing.title}</span>
          <div className="cx-tab-list">
            {tabs.map((t) => (
              <NavLink key={t.id} to={href(t.id)} end className={() => `cx-tab ${t.id === tab ? "active" : ""}`} aria-current={t.id === tab ? "page" : undefined}>
                {t.label}{t.count !== undefined && t.count > 0 && <span className="tab-count">{t.count}</span>}
                {t.id === tab && <motion.span layoutId="cx-tab-line" className="cx-tab-line" transition={{ type: "spring", bounce: 0.15, duration: 0.4 }} />}
              </NavLink>
            ))}
          </div>
          <span className="cx-tabs-action"><PrimaryAction detail={data} compact /></span>
        </div>
      </nav>

      <div className="container page-body">
        {tab === "overview" && (
          <div className="cx-overview">
            <div className="tab-body">
              {listing.demo && <DemoNotice sponsor={listing.sponsor} network={network} />}
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
              <DocSection id="problem" title="Overview" intro={`What ${listing.sponsor}'s workflow does today, in its own words and figures.`}>
                <p className="problem-text">{listing.problem ?? listing.summary}</p>
                {listing.baseline.accuracy_bp > 0 && (
                  <dl className="today">
                    <div><dt>Accuracy today</dt><dd>{percent(listing.baseline.accuracy_bp)}</dd></div>
                    <div><dt>Cost per ticket</dt><dd>{microDollars(listing.baseline.cost_per_ticket_uusd)}</dd></div>
                    <div><dt>p95 latency</dt><dd>{seconds(listing.baseline.p95_latency_ms)}</dd></div>
                  </dl>
                )}
                <p className="muted small">Figures published by {listing.sponsor} for its current agent. The contract does not measure them.</p>
              </DocSection>
              {gates && (
                <DocSection id="goal" title="Goal" intro={goalSentence(gates, listing.baseline)}>
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
                </DocSection>
              )}
              <DocSection id="testing" title="How it's tested" intro="Builders tune in the open and are scored in private, once, on tickets they never see.">
                <div className="compare">
                  <div className="card card-pad compare-col">
                    <h3>Builders can see</h3>
                    <ul className="check-list">
                      <li>The rules and requirements, as the contract stores them</li>
                      <li>{listing.practice_tickets ? `${listing.practice_tickets} practice tickets` : "Practice tickets"} with their labels, in the <Link to={href("data")}>Data</Link> tab</li>
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
              </DocSection>
              <DocSection id="timeline" title="Timeline">
                <Timeline detail={data} />
              </DocSection>
              {!session.account && (
                <p className="muted small owner-hint">
                  Own this challenge? <button type="button" className="link-button" onClick={() => void session.signIn()}>Connect the owner's wallet</button> to fund, open or withdraw it.
                </p>
              )}
            </div>
            <Sidebar detail={data} sections={overviewSections} />
          </div>
        )}

        {tab === "data" && <ErrorBoundary><DataExplorer detail={data} /></ErrorBoundary>}

        {tab === "leaderboard" && (
          <div className="tab-body">
            <div className="freshness" aria-live="polite">
              <span className="muted small">
                {loading ? "Reading the contract…" : readAt ? <>Read from {network} at {readAt.toISOString().slice(11, 19)} UTC{pending ? ` · ${pending} result${pending > 1 ? "s" : ""} scoring, updating every 10 s` : ""}</> : null}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>{loading && <span className="spinner" aria-hidden="true" />}Refresh</button>
            </div>
            <ErrorBoundary>
              <ChallengeLeaderboard detail={data} highlight={highlight}>
                <FindConfig evaluations={data.evaluations} onFound={setHighlight} />
              </ChallengeLeaderboard>
            </ErrorBoundary>
          </div>
        )}

        {tab === "rules" && <RulesTab detail={data} />}

        {tab === "take-part" && (
          <div className="tab-body">
            <DocSection id="take-part" title="Take part">
              <div className="card card-pad"><TakePart detail={data} /></div>
            </DocSection>
          </div>
        )}

        {tab === "manage" && isOwner && (
          <div className="tab-body">
            <DocSection id="manage" title="Manage challenge" intro={<>You are connected as the owner, <strong className="break">{view.owner}</strong>. Only you see this tab.</>}>
              <div className="card card-pad">
                <ManagePanel id={id} network={network} view={view} rpc={rpcFor(network)} onChanged={refresh} />
              </div>
            </DocSection>
          </div>
        )}
      </div>
    </div>
  );
}
