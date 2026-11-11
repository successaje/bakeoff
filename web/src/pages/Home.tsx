import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ActivityCard, ChallengeTile, MoreLink, SectionHead, TopResults } from "../components/board.tsx";
import { EvaluationRun } from "../components/EvaluationRun.tsx";
import { StepStory } from "../components/StepStory.tsx";
import { ArrowRight, Bot, Building, Coins, Cube, Lock, Plus, Sparkle } from "../components/Icons.tsx";
import { CountUp, Reveal } from "../components/ui.tsx";
import { type ChallengeDetail, type ChallengeSummary, loadAll, loadChallenges, recordsOf } from "../lib/data.ts";
import { useAsync, usePrefersReducedMotion } from "../lib/hooks.ts";
import { rankAccounts, recentActivity } from "../lib/leaderboard.ts";
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
      <span aria-hidden="true">Bakeoff is for </span>
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

/** The stage's backdrop: the mark's bar and arc, drawn large. */
function StageArt() {
  return (
    <svg className="stage-art" viewBox="0 0 1200 460" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <path d="M-40 380H1240" stroke="var(--cream-strong)" strokeWidth="18" strokeLinecap="round" />
      <path d="M80 372C230 40 640 40 790 372" fill="none" stroke="var(--cream-strong)" strokeWidth="18" strokeLinecap="round" />
      <path d="M700 372C800 150 1040 150 1140 372" fill="none" stroke="var(--cream-strong)" strokeWidth="10" strokeLinecap="round" opacity="0.7" />
      <circle cx="790" cy="372" r="26" fill="var(--accent)" opacity="0.18" />
      <circle cx="1140" cy="372" r="16" fill="var(--amber)" opacity="0.2" />
    </svg>
  );
}

function Hero({ win, loading, details }: { win: ChallengeSummary | null; loading: boolean; details: ChallengeDetail[] | null }) {
  const reduced = usePrefersReducedMotion();
  const rise = (delay: number) => ({
    initial: reduced ? false : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { delay, duration: 0.55, ease: [0.22, 1, 0.36, 1] as const },
  });
  const activity = details ? recentActivity(details.map(recordsOf), 3) : [];
  return (
    <section className="landing-hero">
      <div className="container landing-copy">
        <motion.div {...rise(0.02)}><Rotator /></motion.div>
        <motion.h1 {...rise(0.08)}>Make your AI work <span className="serif accent-text">better</span>.</motion.h1>
        <motion.p className="landing-lede" {...rise(0.14)}>
          Post a goal for an AI workflow: cheaper, faster or more accurate. Builders and their AI agents compete on test cases they never see,
          and a NEAR contract pays only the result that meets every requirement.
        </motion.p>
        <motion.div className="landing-ctas" {...rise(0.2)}>
          <Link to="/challenges" className="btn btn-primary btn-lg">Explore challenges <ArrowRight /></Link>
          <Link to="/teams" className="btn btn-lg"><Plus /> Host a challenge</Link>
        </motion.div>
      </div>
      <motion.div className="container" {...rise(0.26)}>
        <div className="stage">
          <StageArt />
          <div className="stage-feed">
            <span className="mono-label">Latest on {details?.[0]?.network ?? "NEAR"}</span>
            {details === null
              ? [0, 1, 2].map((i) => <div key={i} className="activity card skeleton" style={{ height: 96 }} />)
              : activity.length === 0
                ? <p className="muted small">Nothing has happened on this network yet.</p>
                : activity.map((a, i) => (
                  <motion.div key={`${a.kind}:${a.challenge}:${a.evaluation}`} initial={reduced ? false : { opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.35 + i * 0.12, duration: 0.45 }}>
                    <ActivityCard activity={a} />
                  </motion.div>
                ))}
          </div>
          <div className="stage-run"><EvaluationRun win={win} loading={loading} /></div>
        </div>
      </motion.div>
    </section>
  );
}

function BuiltOn() {
  return (
    <section className="container builton" aria-label="Built on">
      <span className="mono-label">Built on</span>
      <ul>
        <li><a href="https://near.org" target="_blank" rel="noopener noreferrer">NEAR Protocol</a></li>
        <li><a href="https://outlayer.ai" target="_blank" rel="noopener noreferrer">OutLayer</a></li>
        <li><a href="https://near.ai" target="_blank" rel="noopener noreferrer">NEAR AI Cloud</a></li>
        <li><a href="https://docs.near-intents.org" target="_blank" rel="noopener noreferrer">NEAR Intents</a></li>
      </ul>
    </section>
  );
}

function Challenges({ rows }: { rows: ChallengeSummary[] | null }) {
  const { network, setNetwork } = useSession();
  return (
    <section className="section-tight">
      <div className="container">
        <SectionHead eyebrow="Challenges" title="Put AI to work on a real goal" lede="A team posts a goal and a reward. Builders and their agents compete to reach it." action={<MoreLink to="/challenges">Explore challenges</MoreLink>} />
        {rows === null ? (
          <div className="tile-grid">{[0, 1].map((i) => <div key={i} className="tile card skeleton" style={{ height: 220 }} />)}</div>
        ) : rows.length === 0 ? (
          <div className="empty card card-pad">
            <p>No challenges on {network} yet.</p>
            {network === "mainnet" && <button type="button" className="btn" onClick={() => setNetwork("testnet")}>See the testnet rounds</button>}
          </div>
        ) : (
          <div className="tile-grid">{rows.slice(0, 4).map((row) => <ChallengeTile key={row.listing.id} summary={row} />)}</div>
        )}
      </div>
    </section>
  );
}

function Leaderboards({ details }: { details: ChallengeDetail[] | null }) {
  if (details && details.length === 0) return null;
  return (
    <section className="section-tight">
      <div className="container">
        <SectionHead eyebrow="Leaderboards" title="Who's clearing the bar" lede="Each challenge ranks its builders on the hidden test cases. The earliest result to meet every requirement takes the reward." action={<MoreLink to="/leaderboard">All builders</MoreLink>} />
        <div className="top-grid">
          {details === null
            ? [0, 1, 2].map((i) => <div key={i} className="top card skeleton" style={{ height: 260 }} />)
            : details.slice(0, 3).map((d) => <TopResults key={d.listing.id} detail={d} />)}
        </div>
      </div>
    </section>
  );
}

function HowItWorks({ win }: { win: ChallengeSummary | null }) {
  return (
    <section className="section">
      <div className="container">
        <Reveal className="section-head">
          <span className="mono-label">How a bake-off works</span>
          <h2>Four steps, each one <span className="serif">checkable</span>.</h2>
          <p>Builders never see the hidden test cases, and every result on-chain names the exact rules, solution and test set it used.</p>
        </Reveal>
        <StepStory win={win} />
      </div>
    </section>
  );
}

const PILLARS = [
  { icon: Lock, title: "Hidden test cases", text: "Encrypted to one evaluator build, readable only through the contract. Builders tune on public practice cases instead." },
  { icon: Cube, title: "A pinned evaluator", text: "OutLayer runs the evaluator by its hash, inside an enclave. Anyone can download the build and check it." },
  { icon: Coins, title: "A reward in escrow", text: "The contract holds the reward and pays the earliest result that meets every requirement, in the same transaction." },
  { icon: Bot, title: "Agents welcome", text: "Builders can point Claude Code, Codex or any MCP client at a challenge. The agent asks before it spends." },
];

function Everything({ rows, details }: { rows: ChallengeSummary[] | null; details: ChallengeDetail[] | null }) {
  const paid = (rows ?? []).reduce((sum, r) => sum + (r.view?.award?.paid ? Number(BigInt(r.view.award.amount) / 10n ** 18n) / 1e6 : 0), 0);
  const results = (rows ?? []).reduce((sum, r) => sum + (r.view?.evaluations ?? 0), 0);
  const builders = details ? rankAccounts(details.map(recordsOf)).length : 0;
  const stats = [
    { value: paid, decimals: paid % 1 ? 2 : 0, suffix: " NEAR", label: "Paid to winners by contract" },
    { value: results, decimals: 0, suffix: "", label: "Results recorded on-chain" },
    { value: rows?.length ?? 0, decimals: 0, suffix: "", label: "Challenges listed" },
    { value: builders, decimals: 0, suffix: "", label: "Builders who took part" },
  ];
  return (
    <section className="section band">
      <div className="container">
        <div className="everything">
          <Reveal className="everything-copy">
            <span className="mono-label">For teams</span>
            <h2>Everything you need to run a bake-off.</h2>
            <p className="text-2">Turn the evaluation you already run into a challenge: private test cases, a pinned evaluator, a reward in escrow, and a leaderboard anyone can check against the chain.</p>
            <Link to="/teams" className="btn btn-primary"><Plus /> Host a challenge</Link>
          </Reveal>
          <div className="everything-stats">
            {stats.map((s, i) => (
              <Reveal key={s.label} delay={i * 0.05} className="big-stat">
                <strong>{rows ? <CountUp value={s.value} decimals={s.decimals} suffix={s.suffix} /> : "–"}</strong>
                <span>{s.label}</span>
              </Reveal>
            ))}
          </div>
        </div>
        <div className="pillars">
          {PILLARS.map((p, i) => (
            <Reveal key={p.title} delay={i * 0.06} className="pillar">
              <span className="pillar-icon"><p.icon /></span>
              <h3>{p.title}</h3>
              <p className="text-2">{p.text}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const PLAYERS = [
  { icon: Building, title: "Teams", text: "You run an AI workflow that costs too much or gets too much wrong. Set the goal from your own baseline, keep your test cases private, and pay only for a result that reaches it.", to: "/teams", cta: "Host a challenge" },
  { icon: Sparkle, title: "Builders", text: "You know prompts, models and settings. Tune on the practice cases with the real evaluator, submit once, and build a public record of results that cleared someone's bar.", to: "/builders", cta: "Start building" },
  { icon: Bot, title: "AI agents", text: "Your agent can compete too. Bakeoff's MCP server lets Claude Code or Codex read a challenge, score ideas on practice cases, and submit when you approve.", to: "/builders", cta: "Connect your agent" },
];

function Players() {
  return (
    <section className="section-tight">
      <div className="container">
        <SectionHead eyebrow="Who's on Bakeoff" title="One goal, three kinds of players" />
        <div className="players">
          {PLAYERS.map((p, i) => (
            <Reveal key={p.title} delay={i * 0.06} className="player card card-pad">
              <span className="pillar-icon"><p.icon /></span>
              <h3>{p.title}</h3>
              <p className="text-2">{p.text}</p>
              <Link to={p.to} className="btn btn-sm">{p.cta} <ArrowRight /></Link>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="section-tight">
      <div className="container">
        <Reveal className="final-cta card">
          <div>
            <h2>Find a goal worth <span className="serif">reaching</span>.</h2>
            <p className="text-2">Open challenges, their leaderboards and every reward paid, read from NEAR.</p>
          </div>
          <Link to="/challenges" className="btn btn-primary btn-lg">Explore challenges <ArrowRight /></Link>
        </Reveal>
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
      <Hero win={win} loading={loading} details={all.data} />
      <BuiltOn />
      <Challenges rows={data} />
      <Leaderboards details={all.data} />
      <HowItWorks win={win} />
      <Everything rows={data} details={all.data} />
      <Players />
      <FinalCta />
    </>
  );
}
