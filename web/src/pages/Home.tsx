import { motion } from "motion/react";
import { Link } from "react-router";
import { ChallengeCard, costCut, TheBar } from "../components/challenge.tsx";
import { HeroScene } from "../components/HeroScene.tsx";
import { ArrowRight, Bot, Building, Coins, Cube, Hash, Lock, Shield } from "../components/Icons.tsx";
import { CountUp, DemoBadge, Reveal } from "../components/ui.tsx";
import { type ChallengeSummary, loadChallenges } from "../lib/data.ts";
import { microDollars, percent } from "../lib/format.ts";
import { challengeGates, formatNear } from "../lib/near.ts";
import { useAsync, usePrefersReducedMotion } from "../lib/hooks.ts";
import { useSession } from "../lib/session.tsx";


function latestWin(rows: ChallengeSummary[]): ChallengeSummary | null {
  return rows.filter((r) => r.view?.award?.paid && r.winner).sort((a, b) => b.listing.id.localeCompare(a.listing.id))[0] ?? null;
}

function VerdictCard({ win }: { win: ChallengeSummary | null }) {
  const reduced = usePrefersReducedMotion();
  if (!win?.view?.award || !win.winner) return null;
  return (
    <motion.div
      className="verdict-float"
      initial={reduced ? false : { opacity: 0, y: 24, rotateX: 12 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ delay: 0.6, duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="verdict-float-head">
        <span className="badge badge-dot badge-green">Result · Passed</span>
        <span className="mono small muted">result #{win.view.award.evaluation}{win.listing.demo ? " · demo" : ""}</span>
      </div>
      <dl>
        <div><dt>Accuracy</dt><dd>{percent(win.winner.accuracy_bp)}</dd></div>
        <div><dt>Per ticket</dt><dd>{microDollars(win.winner.cost_per_ticket_uusd)}</dd></div>
        <div><dt>Leaks</dt><dd>{win.winner.leaks ?? 0}</dd></div>
      </dl>
      <div className="verdict-float-paid">
        <Coins />
        <span>Contract paid <strong className="amber">{formatNear(win.view.award.amount)}</strong></span>
      </div>
    </motion.div>
  );
}

function Hero({ win }: { win: ChallengeSummary | null }) {
  const reduced = usePrefersReducedMotion();
  const rise = (delay: number) => ({
    initial: reduced ? false : { opacity: 0, y: 22 },
    animate: { opacity: 1, y: 0 },
    transition: { delay, duration: 0.8, ease: [0.22, 1, 0.36, 1] as const },
  });
  return (
    <section className="hero">
      <HeroScene />
      <div className="hero-fade" aria-hidden="true" />
      <div className="container hero-inner">
        <div className="hero-copy">
          <motion.span className="eyebrow" {...rise(0.05)}>AI workflow bake-offs on NEAR</motion.span>
          <motion.h1 {...rise(0.12)}>
            Make your AI<br />
            work <span className="serif accent-text">better</span>.
          </motion.h1>
          <motion.p className="hero-lede" {...rise(0.22)}>
            Set a goal for an AI workflow: cheaper, faster or more accurate. Builders and their AI agents compete to reach it on test cases they never see,
            and a NEAR contract pays the reward only for a result that meets every requirement.
          </motion.p>
          <motion.div className="hero-ctas" {...rise(0.32)}>
            <Link to="/challenges" className="btn btn-primary btn-lg">Explore challenges <ArrowRight /></Link>
            <Link to="/teams" className="btn btn-lg">Set up a challenge</Link>
          </motion.div>
          <motion.ul className="hero-proof" {...rise(0.42)}>
            <li><Lock /> Tested in an OutLayer enclave</li>
            <li><Shield /> Settled by a NEAR contract</li>
            <li><Cube /> Models on NEAR AI Cloud</li>
          </motion.ul>
        </div>
        <VerdictCard win={win} />
      </div>
    </section>
  );
}

function Stats({ rows }: { rows: ChallengeSummary[] | null }) {
  const paid = (rows ?? []).reduce((sum, r) => sum + (r.view?.award?.paid ? Number(BigInt(r.view.award.amount) / 10n ** 18n) / 1e6 : 0), 0);
  const verdicts = (rows ?? []).reduce((sum, r) => sum + (r.view?.evaluations ?? 0), 0);
  const cuts = (rows ?? []).map((r) => costCut(r.listing.baseline, r.winner)).filter((c): c is number => c !== null);
  const gains = (rows ?? []).filter((r) => r.winner?.accuracy_bp).map((r) => (r.winner!.accuracy_bp! - r.listing.baseline.accuracy_bp) / 100);
  const items = [
    { value: paid, decimals: paid % 1 ? 2 : 0, suffix: " NEAR", label: "Paid to winners by contract" },
    { value: verdicts, decimals: 0, suffix: "", label: "Results recorded on-chain" },
    { value: cuts.length ? Math.max(...cuts) : 0, decimals: 0, suffix: "%", label: "Cheaper than the baseline" },
    { value: gains.length ? Math.max(...gains) : 0, decimals: 1, prefix: "+", suffix: " pts", label: "More accurate than the baseline" },
  ];
  return (
    <section className="stats-band">
      <div className="container stats-grid">
        {items.map((item, i) => (
          <Reveal key={item.label} delay={i * 0.06} className="stat-cell">
            <strong>{rows ? <CountUp value={item.value} decimals={item.decimals} prefix={item.prefix} suffix={item.suffix} /> : "–"}</strong>
            <span>{item.label}</span>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

const STEPS = [
  { icon: Building, title: "Set the goal", text: "A team publishes its workflow's baseline, commits to hidden test cases by hash, sets requirements for quality, cost, speed and leaks, and puts up a reward." },
  { icon: Bot, title: "Compete in the open", text: "Builders and their agents tune solutions on public practice cases, scored by the exact evaluator the challenge pins." },
  { icon: Lock, title: "Test on hidden cases", text: "Each submission runs once inside an OutLayer enclave against the hidden cases. Only totals and hashes come out." },
  { icon: Coins, title: "Reward the result", text: "The contract checks every hash against its commitments, records the result, and pays the first solution that meets every requirement." },
];

function HowItWorks() {
  return (
    <section className="section">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">How a bake-off works</span>
          <h2>Four steps, each one <span className="serif">checkable</span>.</h2>
          <p>Builders never see the hidden test cases, and every result on-chain names the exact rules, solution and test set it used.</p>
        </Reveal>
        <ol className="steps">
          {STEPS.map((step, i) => (
            <Reveal as="li" key={step.title} delay={i * 0.08} className="step card card-pad">
              <span className="step-index mono">0{i + 1}</span>
              <span className="step-icon"><step.icon /></span>
              <h3>{step.title}</h3>
              <p className="text-2">{step.text}</p>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Spotlight({ win }: { win: ChallengeSummary | null }) {
  const gates = win?.view ? challengeGates(win.view) : null;
  if (!win || !gates) return null;
  const cut = costCut(win.listing.baseline, win.winner);
  const gain = win.winner?.accuracy_bp ? (win.winner.accuracy_bp - win.listing.baseline.accuracy_bp) / 100 : null;
  return (
    <section className="section spotlight">
      <div className="container spotlight-grid">
        <Reveal className="spotlight-copy">
          <span className="eyebrow">From goal to result</span>{win.listing.demo && <> <DemoBadge /></>}
          <h2>{win.listing.story?.headline ?? <>The bar, <span className="serif">cleared</span>.</>}</h2>
          <p className="text-2">
            {win.listing.story?.text && <>{win.listing.story.text} </>}
            The winning solution met every requirement on the hidden test
            {cut !== null && gain !== null && <>: <strong className="accent">{cut}% cheaper</strong> and <strong className="accent">{gain.toFixed(1)} points more accurate</strong> than {win.listing.sponsor}'s own agent</>}.
            {" "}The contract paid {formatNear(win.view!.award!.amount)} with the result.
          </p>
          <div className="row">
            <Link to={`/challenges/${win.listing.id}/results/${win.view!.award!.evaluation}`} className="btn btn-primary">See the winning result <ArrowRight /></Link>
            <Link to={`/challenges/${win.listing.id}`} className="btn btn-ghost">The challenge</Link>
          </div>
        </Reveal>
        <Reveal delay={0.1} className="card card-pad spotlight-card">
          <div className="spotlight-card-head">
            <span>{win.listing.title}</span>
            <span className="badge badge-sky badge-dot">Awarded</span>
          </div>
          <TheBar gates={gates} baseline={win.listing.baseline} best={win.winner} bestLabel="Winner" />
        </Reveal>
      </div>
    </section>
  );
}

function Live({ rows }: { rows: ChallengeSummary[] | null }) {
  const { network } = useSession();
  return (
    <section className="section">
      <div className="container">
        <div className="section-row">
          <Reveal className="section-head">
            <span className="eyebrow">On {network}</span>
            <h2>Challenges</h2>
          </Reveal>
          <Link to="/challenges" className="btn btn-ghost">All challenges <ArrowRight /></Link>
        </div>
        {rows === null ? (
          <div className="card-grid">{[0, 1].map((i) => <div key={i} className="card skeleton-card skeleton" />)}</div>
        ) : rows.length === 0 ? (
          <div className="empty card card-pad"><p>No challenges on {network} yet.</p><p className="muted small">Switch to testnet in the header to see the live demo rounds.</p></div>
        ) : (
          <div className="card-grid">{rows.slice(0, 3).map((row, i) => <ChallengeCard key={row.listing.id} summary={row} index={i} />)}</div>
        )}
      </div>
    </section>
  );
}

function Audiences() {
  return (
    <section className="section-tight">
      <div className="container audience-grid">
        <Reveal className="audience card card-pad">
          <span className="audience-icon"><Building /></span>
          <h3>For teams</h3>
          <p className="text-2">Turn "our AI workflow costs too much" into a challenge. Set requirements from your own baseline, keep your test cases hidden from builders, and pay only for a result that meets them.</p>
          <Link to="/teams" className="btn">Set up a challenge <ArrowRight /></Link>
        </Reveal>
        <Reveal delay={0.08} className="audience card card-pad">
          <span className="audience-icon"><Bot /></span>
          <h3>For builders and their agents</h3>
          <p className="text-2">Point Claude Code, Codex or any MCP client at Bakeoff. Your agent reads the goal, scores solutions on practice cases with the real evaluator, and submits when you approve.</p>
          <Link to="/builders" className="btn">Connect your agent <ArrowRight /></Link>
        </Reveal>
      </div>
    </section>
  );
}

function Trust() {
  const items = [
    { icon: Hash, title: "The rules are committed", text: "The contract stores the rules' SHA-256. Every result names the rules it was scored under, or it is rejected." },
    { icon: Cube, title: "The evaluator is pinned", text: "OutLayer runs the evaluator by hash. Anyone can download the build and check it against the challenge." },
    { icon: Lock, title: "The test cases stay hidden", text: "They are encrypted to that one build and readable only through the contract. Only their hash is public." },
  ];
  return (
    <section className="section trust">
      <div className="grid-bg trust-grid-bg" aria-hidden="true" />
      <div className="container">
        <Reveal className="section-head center">
          <span className="eyebrow">Verifiable by design</span>
          <h2>Check it <span className="serif">yourself</span>.</h2>
          <p>Every challenge page checks these commitments in your browser, against the chain. What they cannot prove is listed on How it works.</p>
        </Reveal>
        <div className="trust-items">
          {items.map((item, i) => (
            <Reveal key={item.title} delay={i * 0.08} className="trust-item">
              <span className="trust-icon"><item.icon /></span>
              <h3>{item.title}</h3>
              <p className="text-2">{item.text}</p>
            </Reveal>
          ))}
        </div>
        <Reveal className="center"><Link to="/how-it-works" className="btn">How verification works <ArrowRight /></Link></Reveal>
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
            <p className="text-2">Open challenges, their results and every reward paid, read from NEAR.</p>
          </div>
          <Link to="/challenges" className="btn btn-primary btn-lg">Explore challenges <ArrowRight /></Link>
        </Reveal>
      </div>
    </section>
  );
}

export function Home() {
  const { network } = useSession();
  const { data } = useAsync(() => loadChallenges(network), network);
  const win = data ? latestWin(data) : null;
  return (
    <>
      <Hero win={win} />
      <Stats rows={data} />
      <HowItWorks />
      <Spotlight win={win} />
      <Live rows={data} />
      <Audiences />
      <Trust />
      <FinalCta />
    </>
  );
}
