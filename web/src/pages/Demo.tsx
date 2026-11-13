/**
 * The demo film: a self-playing story of Bakeoff, made to be screen-recorded
 * at 1920×1080. It runs on a fixed 16:9 stage scaled to the window, one clock
 * drives every scene, and the figures come from the chain and the listing.
 *
 * Keys: Space plays and pauses, ← and → move between scenes, R restarts,
 * F goes full screen, H hides the controls. To rehearse one moment, open
 * #/demo?scene=<id>&at=<ms>, which starts paused there. With ?render the
 * film hides its controls and plays as soon as its data and fonts are in,
 * and reports through window.__film, for rendering it to a video file.
 */

import { animate, AnimatePresence, motion } from "motion/react";
import { createContext, memo, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Avatar } from "../components/art.tsx";
import { EvaluationRun } from "../components/EvaluationRun.tsx";
import { Book, Bot, Check, Coins, Cube, Database, Flag, Layers, Lock, LogoMark, Search, Shield } from "../components/Icons.tsx";
import { AgentSession, RidgeArt, ridgeLabels } from "../components/landing.tsx";
import { McpMark, NearAiMark, NearIntentsLogo, NearMark, OutLayerLogo } from "../components/logos.tsx";
import { GoalPanel } from "../components/StepPanels.tsx";
import { type ChallengeSummary, latestWin, loadChallenges } from "../lib/data.ts";
import { microDollars, percent, seconds, shortHash } from "../lib/format.ts";
import { formatNear } from "../lib/near.ts";
import { applyTheme, storedTheme } from "../lib/theme.ts";
import "../styles/film.css";

const EASE = [0.22, 1, 0.36, 1] as const;
const W = 1920;
const H = 1080;

/** The mainnet payment to the first winner, as recorded in the README. */
const MAINNET_CHALLENGE = "challenge-20261107153920.bakeoff.near";
const MAINNET_PAYMENT = "9PGW15xgpFqaueAWr9Q6LedH6bvdQWH6aP1njCT22BUy";

interface Ticket { id: string; text: string; label: { category: string; priority: string } }
interface FilmData { win: ChallengeSummary | null; tickets: Ticket[] }

declare global {
  interface Window { __film?: { ready: boolean; done: boolean; total: number } }
}

/** Milliseconds into the current scene. */
const Clock = createContext(0);
const useT = () => useContext(Clock);

/** Shows its children from `at` until `until` (ms into the scene), easing in and out. */
function Beat({ at, until, className, children, from = { opacity: 0, y: 28 } }: { at: number; until?: number; className?: string; children: ReactNode; from?: Record<string, number> }) {
  const t = useT();
  const on = t >= at && (until === undefined || t < until);
  return (
    <AnimatePresence>
      {on && (
        <motion.div className={className} initial={from} animate={{ opacity: 1, x: 0, y: 0, scale: 1 }} exit={{ opacity: 0, y: -18, transition: { duration: 0.45, ease: EASE } }} transition={{ duration: 0.8, ease: EASE }}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A line set word by word. */
function Words({ text, delay = 0, stagger = 0.06 }: { text: string; delay?: number; stagger?: number }) {
  return (
    <>
      {text.split(" ").map((word, i) => (
        <span key={i}>
          <motion.span className="w" initial={{ opacity: 0, y: "0.45em" }} animate={{ opacity: 1, y: 0 }} transition={{ delay: delay + i * stagger, duration: 0.7, ease: EASE }}>{word}</motion.span>{" "}
        </span>
      ))}
    </>
  );
}

/** A figure that counts up to its value. */
function Count({ to, decimals = 0, suffix = "", delay = 0 }: { to: number; decimals?: number; suffix?: string; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const controls = animate(0, to, {
      duration: 1.5, delay, ease: EASE,
      onUpdate: (v) => { if (ref.current) ref.current.textContent = `${v.toFixed(decimals)}${suffix}`; },
    });
    return () => controls.stop();
  }, [to, decimals, suffix, delay]);
  return <span ref={ref}>{(0).toFixed(decimals)}{suffix}</span>;
}

function figures(win: ChallengeSummary | null) {
  const base = win?.listing.baseline ?? { accuracy_bp: 8700, cost_per_ticket_uusd: 128, p95_latency_ms: 18159 };
  const m = win?.winner ?? null;
  return {
    base,
    m,
    cheaper: m?.cost_per_ticket_uusd ? Math.round((1 - m.cost_per_ticket_uusd / base.cost_per_ticket_uusd) * 100) : null,
    faster: m?.p95_latency_ms ? Math.round(base.p95_latency_ms / m.p95_latency_ms) : null,
  };
}

/* ---------- Scenes ---------- */

function Hook() {
  return (
    <div className="sc">
      <Beat at={300} until={4700} className="beat-abs">
        <p className="sc-kicker"><Words text="Somewhere right now," /></p>
        <h1 className="sc-h1"><Words text="an AI agent is answering your customers." delay={0.7} /></h1>
      </Beat>
      <Beat at={5100} until={7600} className="beat-abs">
        <h1 className="sc-h1">It costs <span className="hot">more</span> than it should.</h1>
      </Beat>
      <Beat at={7900} className="beat-abs">
        <h1 className="sc-h1">And nobody can prove<br />a better one exists.</h1>
      </Beat>
    </div>
  );
}

function TicketStream({ tickets, base }: { tickets: Ticket[]; base: ReturnType<typeof figures>["base"] }) {
  const list = tickets.length ? [...tickets, ...tickets] : [];
  return (
    <div className="stream" aria-hidden="true">
      <div className="stream-track" style={{ animationDuration: `${Math.max(14, tickets.length * 2.4)}s` }}>
        {list.map((ticket, i) => (
          <div key={`${ticket.id}:${i}`} className="ticket">
            <p>{ticket.text}</p>
            <div className="ticket-foot">
              <span className="ticket-chip">{ticket.label.category}</span>
              <span className={`ticket-chip ${ticket.label.priority === "urgent" ? "urgent" : ""}`}>{ticket.label.priority}</span>
              <span className="ticket-cost">{microDollars(base.cost_per_ticket_uusd)}</span>
              <span className="ticket-wait"><i style={{ animationDelay: `${(i % 5) * 0.4}s` }} />{seconds(base.p95_latency_ms)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Bill({ data }: { data: FilmData }) {
  const { base } = figures(data.win);
  return (
    <div className="sc sc-split">
      <div className="sc-col">
        <Beat at={200}><span className="sc-label">Meet Kettle &amp; Kiln · a fictional homeware store</span></Beat>
        <Beat at={700}><h2 className="sc-h2">Its AI support agent sorts every message for the team.</h2></Beat>
        <Beat at={3700}><h2 className="sc-h2 soft">It works. It's just <span className="hot">slow</span> and <span className="hot">expensive</span>.</h2></Beat>
        <Beat at={6200} className="bill-stats">
          <div><strong>{microDollars(base.cost_per_ticket_uusd)}</strong><span>for every ticket it answers</span></div>
          <div><strong>{seconds(base.p95_latency_ms)}</strong><span>one reply in twenty takes longer</span></div>
        </Beat>
      </div>
      <Beat at={400} className="sc-col bill-stream" from={{ opacity: 0, x: 60 }}>
        <TicketStream tickets={data.tickets} base={base} />
      </Beat>
    </div>
  );
}

const PATHS = [
  { title: "Public benchmarks", text: "Leak into training data. The scores stop meaning anything." },
  { title: "Vendor demos", text: "Graded by the people selling." },
  { title: "Consultants", text: "Paid up front, whether it works or not." },
];

function Problem() {
  const t = useT();
  return (
    <div className="sc sc-stackv">
      <Beat at={200}><h2 className="sc-h2 center">So how do you find a better one?</h2></Beat>
      <div className="paths">
        {PATHS.map((p, n) => {
          const struck = t >= 5600 + n * 420;
          return (
            <Beat key={p.title} at={1300 + n * 550} className="path-wrap">
              <motion.div className="path" animate={{ opacity: struck ? 0.42 : 1 }} transition={{ duration: 0.6, ease: EASE }}>
                <span className="path-n">{String(n + 1).padStart(2, "0")}</span>
                <h3>
                  {p.title}
                  <motion.i className="path-strike" initial={{ scaleX: 0 }} animate={{ scaleX: struck ? 1 : 0 }} transition={{ duration: 0.5, ease: EASE }} />
                </h3>
                <p>{p.text}</p>
              </motion.div>
            </Beat>
          );
        })}
      </div>
      <Beat at={8400}><h2 className="sc-h2 center">Teams pay for <span className="soft">effort</span>. Not for <span className="good">results</span>.</h2></Beat>
    </div>
  );
}

function Turn({ data }: { data: FilmData }) {
  return (
    <div className="sc">
      <Beat at={300} until={3700} className="beat-abs">
        <h1 className="sc-h1">What if you only paid<br />for <span className="serif accent">proof</span>?</h1>
      </Beat>
      <Beat at={4000} className="turn-brand" from={{ opacity: 0, y: 24, scale: 0.96 }}>
        <span className="turn-mark"><LogoMark size={92} /></span>
        <h1 className="turn-name">Bakeoff</h1>
        <p className="turn-tag">Make your AI work <span className="serif accent">better</span>.</p>
      </Beat>
      <Beat at={4400} className="turn-ridge" from={{ opacity: 0, y: 80 }}>
        <RidgeArt {...ridgeLabels(data.win)} />
      </Beat>
    </div>
  );
}

function Step({ n, title, text, children, art = 600 }: { n: number; title: ReactNode; text: string; children: ReactNode; art?: number }) {
  return (
    <div className="sc sc-split step">
      <div className="sc-col">
        <Beat at={200}><span className="sc-label">How it works · {String(n).padStart(2, "0")} of 04</span></Beat>
        <Beat at={500}><h2 className="sc-h2">{title}</h2></Beat>
        <Beat at={1300}><p className="sc-p">{text}</p></Beat>
      </div>
      <Beat at={art} className="sc-col step-art" from={{ opacity: 0, y: 40, scale: 0.97 }}>{children}</Beat>
    </div>
  );
}

const Goal = ({ data }: { data: FilmData }) => (
  <Step n={1} title={<>A team sets the <span className="accent">goal</span>.</>} text="It measures its own AI first, sets what better means for accuracy, cost, speed and leaks, seals 100 test tickets by their hash, and locks the reward in a NEAR contract.">
    <div className="film-panel"><GoalPanel win={data.win} /></div>
  </Step>
);

const Compete = () => (
  <Step n={2} title={<>Builders and their <span className="accent">AI agents</span> compete.</>} text="They tune on public practice tickets with the exact evaluator the contract pins. The hidden tickets stay sealed, so nobody can train on the test.">
    <div className="film-session"><AgentSession outcome={null} /></div>
  </Step>
);

const Sealed = ({ data }: { data: FilmData }) => (
  <Step n={3} title={<>Scored once, on tickets <span className="accent">nobody has seen</span>.</>} text="Each submission runs inside an OutLayer enclave on NEAR AI Cloud. Not the builder, not the team, not us: only the totals come out." art={900}>
    <div className="film-run"><EvaluationRun win={data.win} loading={!data.win} /></div>
  </Step>
);

function Paid({ data }: { data: FilmData }) {
  const t = useT();
  const award = data.win?.view?.award;
  const arrived = t >= 3200;
  return (
    <div className="sc sc-stackv paid">
      <Beat at={200}><span className="sc-label center">How it works · 04 of 04</span></Beat>
      <Beat at={500}><h2 className="sc-h2 center">The contract checks every hash, and <span className="accent">pays</span>.</h2></Beat>
      <Beat at={1100} className="pay-row" from={{ opacity: 0, y: 30 }}>
        <div className="pay-box">
          <span className="pay-k">Challenge contract</span>
          <strong className="mono">{data.win ? `${data.win.listing.id.slice(0, 14)}…${data.win.listing.id.slice(-12)}` : "–"}</strong>
          <span className="pay-sub"><Lock /> Locked · 0 keys</span>
        </div>
        <div className="pay-lane">
          <motion.span className="pay-coin" initial={{ x: 0, opacity: 0 }} animate={t >= 1800 ? { x: 288, opacity: [0, 1, 1, 0] } : {}} transition={{ duration: 1.3, ease: EASE, opacity: { duration: 1.3, times: [0, 0.15, 0.85, 1] } }}><Coins /></motion.span>
        </div>
        <motion.div className="pay-box" animate={{ borderColor: arrived ? "var(--gold)" : "var(--border-strong)" }} transition={{ duration: 0.5 }}>
          <span className="pay-k">Winner</span>
          <strong className="pay-who">{award && <Avatar id={award.winner} size={34} />}{award?.winner ?? "–"}</strong>
          <motion.span className="pay-amount" initial={{ opacity: 0, y: 8 }} animate={arrived ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.5, ease: EASE }}>
            <Check /> +{award ? formatNear(award.amount) : "–"}
          </motion.span>
        </motion.div>
      </Beat>
      <Beat at={4300}><p className="sc-p center">In the same transaction. No invoices, no disputes: the rules were fixed before anyone competed.</p></Beat>
      {data.win?.listing.id === MAINNET_CHALLENGE && <Beat at={5600}><p className="pay-tx mono center">tx {MAINNET_PAYMENT.slice(0, 10)}…{MAINNET_PAYMENT.slice(-6)} · nearblocks.io</p></Beat>}
    </div>
  );
}

function Proof({ data }: { data: FilmData }) {
  const { base, m, cheaper, faster } = figures(data.win);
  const stats = [
    { label: "Accuracy", value: <Count to={(m?.accuracy_bp ?? 0) / 100} decimals={1} suffix="%" delay={0.2} />, was: `team's setup ${percent(base.accuracy_bp)}`, chip: "above the bar" },
    { label: "Cost per ticket", value: <Count to={m?.cost_per_ticket_uusd ?? 0} suffix=" µ$" delay={0.35} />, was: `was ${microDollars(base.cost_per_ticket_uusd)}`, chip: cheaper !== null ? `${cheaper}% cheaper` : "" },
    { label: "Slowest replies (p95)", value: <Count to={(m?.p95_latency_ms ?? 0) / 1000} decimals={1} suffix=" s" delay={0.5} />, was: `was ${seconds(base.p95_latency_ms)}`, chip: faster !== null ? `${faster}× faster` : "" },
    { label: "Card numbers leaked", value: <Count to={m?.leaks ?? 0} delay={0.65} />, was: "on tickets planted with them", chip: "none" },
  ];
  return (
    <div className="sc sc-stackv">
      <Beat at={200}><span className="sc-label center live"><i /> This already happened · NEAR mainnet</span></Beat>
      <Beat at={600}><h2 className="sc-h2 center">A Claude Code agent won on its <span className="accent">first try</span>.</h2></Beat>
      <Beat at={1700} className="proof-grid">
        {stats.map((s, i) => (
          <motion.div key={s.label} className="proof" initial={{ opacity: 0, y: 26 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.15, duration: 0.7, ease: EASE }}>
            <span className="proof-k">{s.label}</span>
            <strong>{data.win ? s.value : "–"}</strong>
            <span className="proof-was">{s.was}</span>
            {s.chip && <span className="proof-chip">{s.chip}</span>}
          </motion.div>
        ))}
      </Beat>
      <Beat at={6800}><p className="sc-p center">The contract paid it <strong>{data.win?.view?.award ? formatNear(data.win.view.award.amount) : "–"}</strong>. Every number here is on-chain, for anyone to check.</p></Beat>
    </div>
  );
}

const PROMISES = [
  { icon: Lock, text: "Nobody sees the test cases.", proof: "sealed by hash" },
  { icon: Shield, text: "Nobody can change the rules.", proof: "contract locked · 0 keys" },
  { icon: Coins, text: "Nobody but the contract decides who's paid.", proof: "checked in your browser" },
];

function Trust({ data }: { data: FilmData }) {
  const hash = data.win?.view ? shortHash(data.win.view.test_set_sha256) : "";
  return (
    <div className="sc sc-stackv trust">
      {PROMISES.map((p, i) => (
        <Beat key={p.text} at={400 + i * 2400} className="promise" from={{ opacity: 0, x: -40 }}>
          <span className="promise-icon"><p.icon /></span>
          <h2 className="sc-h2">{p.text}</h2>
          <span className="promise-proof mono">{i === 0 && hash ? `${p.proof} ${hash}` : p.proof}</span>
        </Beat>
      ))}
    </div>
  );
}

const USES = [
  { icon: Bot, name: "Support triage", goal: "cheaper per ticket", live: true },
  { icon: Database, name: "Invoice extraction", goal: "fewer wrong fields" },
  { icon: Shield, name: "Fraud screening", goal: "fewer missed cases" },
  { icon: Cube, name: "Code review", goal: "more real bugs found" },
  { icon: Book, name: "Translation", goal: "higher quality, lower cost" },
  { icon: Flag, name: "Contract review", goal: "every risky clause flagged" },
  { icon: Search, name: "Search ranking", goal: "better answers first" },
  { icon: Layers, name: "Claims coding", goal: "faster, and no leaks" },
];

function Potential() {
  return (
    <div className="sc sc-stackv">
      <Beat at={200}><h2 className="sc-h2 center">Any AI workflow with a goal you can <span className="accent">measure</span>.</h2></Beat>
      <div className="uses">
        {USES.map((u, i) => (
          <Beat key={u.name} at={1300 + i * 220} className="use" from={{ opacity: 0, y: 24, scale: 0.97 }}>
            <span className="use-icon"><u.icon /></span>
            <strong>{u.name}</strong>
            <span className="use-goal">{u.goal}</span>
            {u.live && <span className="use-live">Live on NEAR</span>}
          </Beat>
        ))}
      </div>
      <Beat at={6600}><p className="sc-lead center">A market where AI agents compete to make AI <span className="accent">cheaper, faster and safer</span>,<br />and get paid only when they prove it.</p></Beat>
    </div>
  );
}

function Close() {
  return (
    <div className="sc sc-stackv close">
      <Beat at={200} className="close-brand" from={{ opacity: 0, y: 20, scale: 0.97 }}>
        <span className="turn-mark"><LogoMark size={84} /></span>
        <h1 className="turn-name">Bakeoff</h1>
      </Beat>
      <Beat at={900}><p className="turn-tag">Make your AI work <span className="serif accent">better</span>.</p></Beat>
      <Beat at={2000} className="close-links">
        <span className="close-url">bakeoff-near.vercel.app</span>
        <span className="close-gh mono">github.com/successaje/bakeoff</span>
      </Beat>
      <Beat at={3200} className="close-stack">
        <span><NearMark /> NEAR Protocol</span>
        <span><OutLayerLogo className="wide" /></span>
        <span><NearAiMark /> NEAR AI Cloud</span>
        <span><NearIntentsLogo className="wider" /></span>
        <span><McpMark /> MCP</span>
      </Beat>
      <Beat at={4200}><p className="close-built mono">Built at NEAR HACKATHON</p></Beat>
    </div>
  );
}

/* ---------- Player ---------- */

interface Scene { id: string; label: string; ms: number; tone: "dark" | "light"; View: (props: { data: FilmData }) => ReactNode }

const SCENES: Scene[] = [
  { id: "hook", label: "The hook", ms: 10_500, tone: "dark", View: Hook },
  { id: "bill", label: "The bill", ms: 11_000, tone: "dark", View: Bill },
  { id: "problem", label: "The problem", ms: 12_000, tone: "dark", View: Problem },
  { id: "turn", label: "The turn", ms: 10_000, tone: "light", View: Turn },
  { id: "goal", label: "Set the goal", ms: 11_500, tone: "light", View: Goal },
  { id: "compete", label: "Agents compete", ms: 11_500, tone: "light", View: Compete },
  { id: "sealed", label: "Sealed scoring", ms: 14_000, tone: "light", View: Sealed },
  { id: "paid", label: "The payment", ms: 9_000, tone: "light", View: Paid },
  { id: "proof", label: "The proof", ms: 12_500, tone: "light", View: Proof },
  { id: "trust", label: "Trust", ms: 9_500, tone: "light", View: Trust },
  { id: "potential", label: "The potential", ms: 12_500, tone: "light", View: Potential },
  { id: "close", label: "Bakeoff", ms: 9_000, tone: "light", View: Close },
];

const TOTAL = SCENES.reduce((sum, s) => sum + s.ms, 0);

/**
 * A scene, rendered once. The clock reaches only the parts that read it
 * (beats, strikes, the coin), so a tick never re-renders a whole scene.
 */
const SceneView = memo(function SceneView({ View, data }: { View: Scene["View"]; data: FilmData }) {
  return <View data={data} />;
});
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** One ticket of each kind first, then the rest, so the stream shows variety. */
function pickTickets(all: Ticket[]): Ticket[] {
  const seen = new Set<string>();
  const first = all.filter((t) => !seen.has(t.label.category) && seen.add(t.label.category));
  return [...first, ...all.filter((t) => !first.includes(t))].slice(0, 10);
}

/** Where ?scene= and ?at= ask the film to start, by scene id or number. */
function startAt(params: URLSearchParams): { i: number; t: number } {
  const want = params.get("scene");
  const byId = SCENES.findIndex((s) => s.id === want);
  const i = byId >= 0 ? byId : Math.max(0, Math.min(SCENES.length - 1, Number(want) || 0));
  return { i, t: Math.max(0, Math.min(SCENES[i]!.ms - 1, Number(params.get("at")) || 0)) };
}

export function Demo() {
  const [params] = useSearchParams();
  const [data, setData] = useState<FilmData>({ win: null, tickets: [] });
  const [i, setI] = useState(() => startAt(params).i);
  const [t, setT] = useState(() => startAt(params).t);
  const [run, setRun] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scale, setScale] = useState(1);
  const [awake, setAwake] = useState(true);
  const render = params.has("render");
  const [hudHidden, setHudHidden] = useState(render);
  const sleep = useRef<number | undefined>(undefined);

  // A new ?scene= or ?at= while the film is open moves to it, paused.
  useEffect(() => {
    if (!params.has("scene") && !params.has("at")) return;
    const start = startAt(params);
    setI(start.i);
    setT(start.t);
    setRun((r) => r + 1);
    setPlaying(false);
  }, [params]);

  // The film is designed in the light theme; the visitor's choice comes back on leaving.
  useEffect(() => {
    const title = document.title;
    applyTheme("light");
    document.title = "Bakeoff · Demo";
    return () => {
      applyTheme(storedTheme());
      document.title = title;
    };
  }, []);

  useEffect(() => {
    void loadChallenges("mainnet").then((rows) => setData((d) => ({ ...d, win: latestWin(rows) }))).catch(() => undefined);
    void fetch("data/practice.json").then((r) => r.json() as Promise<Ticket[]>).then((all) => setData((d) => ({ ...d, tickets: pickTickets(all) }))).catch(() => undefined);
  }, []);

  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Rendering to video: start once the chain data, the tickets and the fonts are in, and say when it ends.
  useEffect(() => {
    if (!render || !data.win || data.tickets.length === 0) return;
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live) return;
      window.__film = { ready: true, done: false, total: TOTAL };
      setPlaying(true);
    });
    return () => {
      live = false;
    };
  }, [render, data.win, data.tickets.length]);
  useEffect(() => {
    if (render && window.__film && i === SCENES.length - 1 && t >= SCENES[i]!.ms) window.__film.done = true;
  }, [render, i, t]);

  // The clock: ticks while playing, and moves to the next scene when one ends.
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setT((prev) => prev + dt);
    }, 50);
    return () => window.clearInterval(timer);
  }, [playing]);
  useEffect(() => {
    if (t < SCENES[i]!.ms) return;
    if (i < SCENES.length - 1) {
      setI(i + 1);
      setT(0);
    } else {
      setPlaying(false);
      setT(SCENES[i]!.ms);
    }
  }, [t, i]);

  const go = useCallback((n: number) => {
    setI(Math.max(0, Math.min(SCENES.length - 1, n)));
    setT(0);
    setRun((r) => r + 1);
  }, []);
  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && i === SCENES.length - 1 && t >= SCENES[i]!.ms) go(0);
      return !p;
    });
  }, [i, t, go]);

  const wake = useCallback(() => {
    setAwake(true);
    window.clearTimeout(sleep.current);
    sleep.current = window.setTimeout(() => setAwake(false), 1800);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") { e.preventDefault(); toggle(); }
      else if (e.key === "ArrowRight") go(i + 1);
      else if (e.key === "ArrowLeft") go(t > 1500 ? i : i - 1);
      else if (e.key === "r" || e.key === "R") { go(0); setPlaying(false); }
      else if (e.key === "h" || e.key === "H") setHudHidden((h) => !h);
      else if (e.key === "f" || e.key === "F") void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
      wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, go, i, t, wake]);

  const scene = SCENES[i]!;
  const elapsed = SCENES.slice(0, i).reduce((sum, s) => sum + s.ms, 0) + Math.min(t, scene.ms);
  const showHud = !hudHidden && (!playing || awake);
  const fresh = !render && !playing && i === 0 && t === 0;

  return (
    <div className={`film ${playing && !awake ? "film-quiet" : ""}`} onMouseMove={wake} onClick={toggle}>
      <motion.div className="film-bg" animate={{ backgroundColor: scene.tone === "dark" ? "#0a0e0c" : "#fbf9f4" }} transition={{ duration: 1.4, ease: EASE }} />
      <div className="film-stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <AnimatePresence>
          <motion.section
            key={`${scene.id}:${run}`}
            className={`scene scene-${scene.tone}`}
            initial={{ opacity: 0, scale: 1.02 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.985, transition: { duration: 0.7, ease: EASE } }}
            transition={{ duration: 1, ease: EASE, delay: 0.15 }}
          >
            <Clock.Provider value={t}>
              <SceneView View={scene.View} data={data} />
            </Clock.Provider>
          </motion.section>
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {fresh && (
          <motion.div className="film-start" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <LogoMark size={40} />
            <strong>Bakeoff · the demo</strong>
            <span>Press Space or click to play · F for full screen · H hides the controls</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`film-hud ${showHud ? "on" : ""}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => go(t > 1500 ? i : i - 1)} aria-label="Previous scene">‹</button>
        <button type="button" className="film-play" onClick={toggle}>{playing ? "Pause" : "Play"}</button>
        <button type="button" onClick={() => go(i + 1)} aria-label="Next scene">›</button>
        <div className="film-bars">
          {SCENES.map((s, n) => (
            <button key={s.id} type="button" className="film-bar" style={{ flexGrow: s.ms }} onClick={() => go(n)} title={s.label} aria-label={`Go to ${s.label}`}>
              <span style={{ transform: `scaleX(${n < i ? 1 : n === i ? Math.min(1, t / s.ms) : 0})` }} />
            </button>
          ))}
        </div>
        <span className="film-time">{clock(elapsed)} / {clock(TOTAL)}</span>
        <span className="film-label">{scene.label}</span>
      </div>
    </div>
  );
}
