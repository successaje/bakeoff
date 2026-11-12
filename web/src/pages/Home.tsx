/**
 * The landing page, laid out like a competition site's front page: a short
 * hero over a band of artwork with the latest on-chain activity, what it is
 * built on, leaderboards, challenges, the agents band, a spotlight on how a
 * bake-off works, what a team gets, guides, and what Bakeoff is.
 */

import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { Avatar, Cover, HostMark } from "../components/art.tsx";
import { ActivityCard, ChallengeTile, MoreLink, SectionHead, topEntries } from "../components/board.tsx";
import { EvaluationRun } from "../components/EvaluationRun.tsx";
import { ArrowRight, ArrowUpRight, Check, Coins, Cube, Lock, Plus } from "../components/Icons.tsx";
import { AgentTiles, RidgeArt, StackArt } from "../components/landing.tsx";
import { CompetePanel, GoalPanel, SealedPanel, STEPS } from "../components/StepPanels.tsx";
import { Reveal } from "../components/ui.tsx";
import { type ChallengeDetail, type ChallengeSummary, loadAll, loadChallenges, recordsOf } from "../lib/data.ts";
import { ago, microDollars, percent, seconds } from "../lib/format.ts";
import { useAsync, usePrefersReducedMotion } from "../lib/hooks.ts";
import { rankAccounts, recentActivity } from "../lib/leaderboard.ts";
import { challengeGates, type Gates, type Metrics } from "../lib/near.ts";
import type { Baseline } from "../lib/registry.ts";
import { useSession } from "../lib/session.tsx";

function latestWin(rows: ChallengeSummary[]): ChallengeSummary | null {
  return rows.filter((r) => r.view?.award?.paid && r.winner).sort((a, b) => b.listing.id.localeCompare(a.listing.id))[0] ?? null;
}

const AUDIENCES = ["teams with an AI bill", "prompt engineers", "AI agents", "anyone who wants proof"];

/** "Bakeoff is for …", cycling through who it serves. */
function Rotator() {
  const reduced = usePrefersReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const timer = setInterval(() => setI((n) => (n + 1) % AUDIENCES.length), 2600);
    return () => clearInterval(timer);
  }, [reduced]);
  return (
    <p className="rotator" aria-label={`Bakeoff is for ${AUDIENCES.join(", ")}`}>
      <span aria-hidden="true">Bakeoff is for</span>
      <span className="rotator-slot" aria-hidden="true">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={i} className="rotator-word" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}>
            {AUDIENCES[i]}
          </motion.span>
        </AnimatePresence>
      </span>
    </p>
  );
}

/** The card floating on the hero's band: what just happened on-chain, one item at a time. */
function LiveCard({ details }: { details: ChallengeDetail[] | null }) {
  const reduced = usePrefersReducedMotion();
  const items = details ? recentActivity(details.map(recordsOf), 6) : [];
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduced || items.length < 2) return;
    const timer = setInterval(() => setI((n) => n + 1), 4200);
    return () => clearInterval(timer);
  }, [reduced, items.length]);
  if (details && items.length === 0) return null;
  const item = items.length ? items[i % items.length]! : null;
  return (
    <div className="ridge-card">
      <AnimatePresence mode="wait" initial={false}>
        {item ? (
          <motion.div key={`${item.kind}:${item.challenge}:${item.evaluation}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
            <ActivityCard activity={item} />
          </motion.div>
        ) : <div className="activity card skeleton" style={{ height: 104 }} />}
      </AnimatePresence>
    </div>
  );
}

function Hero({ details }: { details: ChallengeDetail[] | null }) {
  const reduced = usePrefersReducedMotion();
  const rise = (delay: number) => ({
    initial: reduced ? false : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { delay, duration: 0.55, ease: [0.22, 1, 0.36, 1] as const },
  });
  return (
    <section className="landing-hero">
      <div className="container landing-copy">
        <motion.div {...rise(0.02)}><Rotator /></motion.div>
        <motion.h1 {...rise(0.08)}>Make your AI work <span className="serif accent-text">better</span>.</motion.h1>
        <motion.p className="landing-lede" {...rise(0.14)}>
          Teams post a goal for an AI workflow. Builders and their agents compete on test cases they never see, and a NEAR contract pays the result that meets it.
        </motion.p>
      </div>
      <motion.div className="ridge" {...rise(0.22)}>
        <RidgeArt />
        <div className="container ridge-inner"><LiveCard details={details} /></div>
      </motion.div>
    </section>
  );
}

const BUILT_ON = [
  ["NEAR Protocol", "https://near.org"],
  ["OutLayer", "https://outlayer.ai"],
  ["NEAR AI Cloud", "https://near.ai"],
  ["NEAR Intents", "https://docs.near-intents.org"],
  ["Model Context Protocol", "https://modelcontextprotocol.io"],
];

function BuiltOn() {
  return (
    <section className="container builton" aria-label="Built on">
      <span className="mono-label">Built on</span>
      <ul>
        {BUILT_ON.map(([name, href]) => <li key={name}><a href={href} target="_blank" rel="noopener noreferrer">{name}</a></li>)}
      </ul>
    </section>
  );
}

/** A requirement as a leaderboard: how every builder's best result, and the team's own baseline, measure on it. */
interface Board {
  title: string;
  about: (tickets: number) => string;
  value: (m: Metrics) => number | undefined;
  baseline?: (b: Baseline) => number;
  format: (v: number) => string;
  higher: boolean;
  meets: (v: number, g: Gates) => boolean;
  needs: (g: Gates) => string;
}

const BOARDS: Board[] = [
  {
    title: "Accuracy",
    about: (n) => `Share of the ${n} hidden tickets answered correctly, scored inside the enclave.`,
    value: (m) => m.accuracy_bp, baseline: (b) => b.accuracy_bp, format: (v) => percent(v), higher: true,
    meets: (v, g) => v >= g.min_accuracy_bp, needs: (g) => `≥ ${percent(g.min_accuracy_bp)}`,
  },
  {
    title: "Cost per ticket",
    about: () => "What the solution's model calls cost for each ticket, at NEAR AI Cloud prices.",
    value: (m) => m.cost_per_ticket_uusd, baseline: (b) => b.cost_per_ticket_uusd, format: (v) => microDollars(v), higher: false,
    meets: (v, g) => v <= g.max_cost_per_ticket_uusd, needs: (g) => `≤ ${microDollars(g.max_cost_per_ticket_uusd)}`,
  },
  {
    title: "p95 latency",
    about: () => "How long the slowest one ticket in twenty took to answer.",
    value: (m) => m.p95_latency_ms, baseline: (b) => b.p95_latency_ms, format: (v) => seconds(v), higher: false,
    meets: (v, g) => v <= g.max_p95_latency_ms, needs: (g) => `≤ ${seconds(g.max_p95_latency_ms)}`,
  },
  {
    title: "Card numbers repeated",
    about: () => "Answers that repeated a card number from the ticket. The test set plants them on purpose.",
    value: (m) => m.leaks, format: (v) => String(v), higher: false,
    meets: (v, g) => v <= g.max_leaks, needs: (g) => (g.max_leaks === 0 ? "None allowed" : `≤ ${g.max_leaks}`),
  },
];

interface BoardRow { key: string; name: string; value: number; rank: number | null; baseline: boolean }

function BoardCard({ board, detail }: { board: Board; detail: ChallengeDetail }) {
  const gates = challengeGates(detail.view);
  const entries = topEntries(detail).filter((e) => !e.trial && e.metrics);
  const scored = entries.flatMap((e) => {
    const value = board.value(e.metrics!);
    return value === undefined ? [] : [{ key: e.account, name: e.account, value, baseline: false }];
  });
  const base = board.baseline?.(detail.listing.baseline);
  const all = [...scored, ...(base === undefined ? [] : [{ key: "baseline", name: "Team's current setup", value: base, baseline: true }])]
    .sort((a, b) => (board.higher ? b.value - a.value : a.value - b.value));
  let n = 0;
  const rows: BoardRow[] = all.map((row) => ({ ...row, rank: row.baseline ? null : ++n }));
  const shown = rows.slice(0, 3);
  const values = rows.map((r) => r.value);
  const best = board.higher ? Math.max(...values) : Math.min(...values);
  const share = (v: number) => Math.max(0.04, board.higher ? (best > 0 ? v / best : 0) : v === 0 ? 1 : best === 0 ? 0.08 : best / v);
  const updated = entries.map((e) => e.last?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  return (
    <Link to={`/challenges/${detail.listing.id}/leaderboard`} className="bench card">
      <div className="bench-head">
        <h3>{board.title}</h3>
        <p>{board.about(detail.listing.tickets)}</p>
        <span className="bench-org"><HostMark name={detail.listing.sponsor} size={22} /> {detail.listing.sponsor}</span>
      </div>
      <ol className="bench-rows">
        {shown.length === 0 && <li className="bench-empty muted small">No results yet.</li>}
        {shown.map((row, i) => (
          <li key={row.key} className={row.baseline ? "is-baseline" : ""}>
            <div className="bench-line">
              <span className="bench-rank mono">{row.rank === null ? "–" : `#${row.rank}`}</span>
              <span className="bench-name">{!row.baseline && <Avatar id={row.name} size={18} />}<span className="bench-text">{row.name}</span></span>
              <span className={`bench-value mono ${i === 0 ? "top" : ""}`}>{board.format(row.value)}</span>
              <span className={`bench-meets ${gates && board.meets(row.value, gates) ? "met" : ""}`} title={gates && board.meets(row.value, gates) ? "Meets the requirement" : "Misses the requirement"}><Check /></span>
            </div>
            <span className={`bench-bar ${i === 0 && !row.baseline ? "lead" : ""}`}><span style={{ width: `${share(row.value) * 100}%` }} /></span>
          </li>
        ))}
        {rows.length > 3 && <li className="bench-more muted small">+ {rows.length - 3} more</li>}
      </ol>
      <div className="bench-foot">
        <span className="muted small">{updated ? `Updated ${ago(new Date(updated))}` : "No results yet"}</span>
        {gates && <span className="bench-need mono">{board.needs(gates)}</span>}
      </div>
    </Link>
  );
}

function Leaderboards({ details }: { details: ChallengeDetail[] | null }) {
  const [picked, setPicked] = useState<string | null>(null);
  if (details && details.length === 0) return null;
  const detail = details?.find((d) => d.listing.id === picked) ?? details?.[0] ?? null;
  return (
    <section className="landing-section">
      <div className="container">
        <SectionHead
          eyebrow="Leaderboards"
          title="See who clears the bar"
          lede="Every requirement is a leaderboard: each builder's best result on the hidden test cases, next to the team's own setup."
          action={<MoreLink to="/leaderboard">View all</MoreLink>}
        />
        {details && details.length > 0 && (
          <div className="pills" role="tablist" aria-label="Challenge">
            {details.map((d) => (
              <button key={d.listing.id} type="button" role="tab" aria-selected={d === detail} className={`pill ${d === detail ? "active" : ""}`} onClick={() => setPicked(d.listing.id)}>
                {d.listing.title}
              </button>
            ))}
          </div>
        )}
        <div className="bench-grid">
          {detail === null
            ? BOARDS.map((b) => <div key={b.title} className="bench card skeleton" style={{ height: 300 }} />)
            : BOARDS.map((b) => <BoardCard key={`${detail.listing.id}:${b.title}`} board={b} detail={detail} />)}
        </div>
      </div>
    </section>
  );
}

function HostTile() {
  return (
    <Link to="/teams" className="tile tile-new card">
      <span className="tile-new-art"><Plus /></span>
      <div className="tile-body">
        <span className="tile-sponsor">Your team</span>
        <h3>Host a challenge</h3>
        <p className="tile-summary">Turn the evaluation you already run into a challenge, and pay only for a result that meets your goal.</p>
        <span className="tile-new-link">How hosting works <ArrowRight /></span>
      </div>
    </Link>
  );
}

function Challenges({ rows }: { rows: ChallengeSummary[] | null }) {
  const { network, setNetwork } = useSession();
  return (
    <section className="landing-section">
      <div className="container">
        <SectionHead eyebrow="Challenges" title="Put AI to work on a real goal" lede="A team posts a goal and a reward. Builders and their agents compete to reach it." action={<MoreLink to="/challenges">Explore challenges</MoreLink>} />
        {rows === null ? (
          <div className="tile-grid">{[0, 1].map((i) => <div key={i} className="tile card skeleton" style={{ height: 220 }} />)}</div>
        ) : (
          <div className="tile-grid">
            {rows.slice(0, 3).map((row) => <ChallengeTile key={row.listing.id} summary={row} />)}
            {rows.length === 0 && network === "mainnet" && (
              <button type="button" className="tile card tile-empty" onClick={() => setNetwork("testnet")}>No challenges on mainnet yet. See the testnet rounds</button>
            )}
            {rows.slice(0, 3).length % 2 === 1 && <HostTile />}
          </div>
        )}
      </div>
    </section>
  );
}

function AgentsBand() {
  return (
    <section className="agents-band">
      <div className="container agents-inner">
        <Reveal className="agents-copy">
          <span className="mono-label">Agents</span>
          <h2>Bring your own agent</h2>
          <p className="text-2">Claude Code, Codex or any MCP client can read a challenge, score ideas on the practice cases and submit when you approve.</p>
          <MoreLink to="/builders">Connect your agent</MoreLink>
        </Reveal>
        <AgentTiles />
      </div>
    </section>
  );
}

interface Slide { tab: string; title: string; text: string; link: { to: string; label: string }; panel: (win: ChallengeSummary | null, loading: boolean) => ReactNode }

const SLIDES: Slide[] = [
  { tab: "Set the goal", title: "A team sets the goal", text: STEPS[0]!.text, link: { to: "/teams", label: "How hosting works" }, panel: (win) => <GoalPanel win={win} /> },
  { tab: "Compete", title: "Builders compete in the open", text: STEPS[1]!.text, link: { to: "/builders", label: "How to take part" }, panel: (win) => <CompetePanel win={win} /> },
  { tab: "Hidden test", title: "Scored once, on cases nobody sees", text: STEPS[2]!.text, link: { to: "/how-it-works", label: "What stays hidden" }, panel: (win) => <SealedPanel win={win} /> },
  { tab: "Paid", title: "The contract pays the result", text: STEPS[3]!.text, link: { to: "/how-it-works", label: "How it works" }, panel: (win, loading) => <EvaluationRun win={win} loading={loading} /> },
];

/** How a bake-off works, one step at a time, with a tab for each step. */
function Spotlight({ win, loading }: { win: ChallengeSummary | null; loading: boolean }) {
  const reduced = usePrefersReducedMotion();
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (reduced || paused) return;
    const timer = setTimeout(() => setI((n) => (n + 1) % SLIDES.length), i === SLIDES.length - 1 ? 11_000 : 7000);
    return () => clearTimeout(timer);
  }, [i, reduced, paused]);
  const slide = SLIDES[i]!;
  return (
    <section className="landing-section">
      <div className="container">
        <div className="spot card" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
          <div className="spot-copy">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={i} className="spot-text" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
                <span className="mono-label">How a bake-off works · {String(i + 1).padStart(2, "0")}</span>
                <h2>{slide.title}</h2>
                <p className="text-2">{slide.text}</p>
              </motion.div>
            </AnimatePresence>
            <Link to={slide.link.to} className="spot-link">{slide.link.label}</Link>
          </div>
          <div className="spot-art">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={i} className="spot-panel" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
                {slide.panel(win, loading)}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <div className="spot-tabs" role="tablist" aria-label="Steps">
          {SLIDES.map((s, n) => (
            <button key={s.tab} type="button" role="tab" aria-selected={n === i} className={n === i ? "active" : ""} onClick={() => setI(n)}>
              {s.tab}
              {n === i && !reduced && !paused && <span className="spot-progress" style={{ animationDuration: `${n === SLIDES.length - 1 ? 11 : 7}s` }} />}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function Everything({ rows, details }: { rows: ChallengeSummary[] | null; details: ChallengeDetail[] | null }) {
  const paid = (rows ?? []).reduce((sum, r) => sum + (r.view?.award?.paid ? Number(BigInt(r.view.award.amount) / 10n ** 18n) / 1e6 : 0), 0);
  const results = (rows ?? []).reduce((sum, r) => sum + (r.view?.evaluations ?? 0), 0);
  const tickets = (rows ?? []).reduce((sum, r) => sum + r.listing.tickets, 0);
  const builders = details ? rankAccounts(details.map(recordsOf)).length : 0;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const labels = rows
    ? [`${paid % 1 ? paid.toFixed(2) : paid} NEAR paid by contract`, plural(results, "result on-chain", "results on-chain"), plural(tickets, "hidden test case", "hidden test cases"), plural(builders, "builder took part", "builders took part")]
    : ["Rewards paid by contract", "Results on-chain", "Hidden test cases", "Builders"];
  return (
    <section className="landing-section everything-c">
      <div className="container">
        <Reveal className="everything-head">
          <h2>Everything you need to run a bake-off</h2>
          <p className="text-2">Turn the evaluation you already run into a challenge: private test cases, a pinned evaluator, a reward in escrow, and a leaderboard anyone can check against the chain.</p>
          <Link to="/teams" className="btn">Host a challenge <ArrowRight /></Link>
        </Reveal>
        <StackArt labels={labels} />
      </div>
    </section>
  );
}

const GUIDES = [
  { to: "/teams", title: "Host a challenge: from your baseline to a reward", seed: "guide: teams" },
  { to: "/builders", title: "Compete yourself, or let your agent", seed: "guide: builders" },
  { to: "/how-it-works", title: "Sealed, scored, settled: how it works", seed: "guide: how it works" },
];

function Learn() {
  return (
    <section className="landing-section">
      <div className="container">
        <SectionHead title="Learn how it works" action={<MoreLink to="/how-it-works">View all</MoreLink>} />
        <div className="guide-cards">
          {GUIDES.map((g, i) => (
            <Reveal key={g.to + g.title} delay={i * 0.06}>
              <Link to={g.to} className="guide-card">
                <Cover id={g.seed} lit={0.55} className="guide-art" />
                <span className="guide-go"><ArrowUpRight /></span>
                <h3>{g.title}</h3>
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const PILLARS = [
  { icon: Lock, text: "Test cases nobody sees, not even the builders" },
  { icon: Cube, text: "One evaluator build, pinned by its hash" },
  { icon: Coins, text: "A reward the contract holds and pays" },
];

function About() {
  return (
    <section className="landing-section about">
      <div className="container">
        <Reveal>
          <span className="mono-label">About Bakeoff</span>
          <p className="about-text">
            Bakeoff turns the evaluation a team already runs into a sealed, public challenge on NEAR. Builders and their AI agents compete on test cases they never see. OutLayer scores each submission once inside an enclave, with the model on NEAR AI Cloud, and the contract pays the earliest result that meets every requirement, with every hash on-chain for anyone to check.
          </p>
        </Reveal>
        <div className="about-pillars">
          {PILLARS.map((p, i) => (
            <Reveal key={p.text} delay={i * 0.06} className="about-pillar">
              <p.icon />
              <h3>{p.text}</h3>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Home() {
  const { network } = useSession();
  const { data, loading } = useAsync(() => loadChallenges(network), network);
  const all = useAsync(() => loadAll(network), `all:${network}`);
  const win = data ? latestWin(data) : null;
  return (
    <>
      <Hero details={all.data} />
      <BuiltOn />
      <Leaderboards details={all.data} />
      <Challenges rows={data} />
      <AgentsBand />
      <Spotlight win={win} loading={loading} />
      <Everything rows={data} details={all.data} />
      <Learn />
      <About />
    </>
  );
}
