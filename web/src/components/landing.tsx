/**
 * Artwork for the landing page, drawn in code from a fixed seed: the ridge
 * behind the hero, which doubles as a chart of the latest win, and the agents
 * band's tile wall and session. Colours come from theme tokens, so each piece
 * reads in light and dark.
 */

import { motion } from "motion/react";
import { type ComponentType, type CSSProperties, memo, type SVGProps } from "react";
import type { ChallengeSummary } from "../lib/data.ts";
import { microDollars, percent, seconds } from "../lib/format.ts";
import { challengeGates } from "../lib/near.ts";
import { hashString, seeded } from "./art.tsx";
import { Bot, Check, Coins, Cube, Lock, Shield, Sparkle } from "./Icons.tsx";

const W = 1440;
const H = 320;
const PITCH = 12;
const SIZE = 10;

/** Height of the ridge at x: the winner's peak, the team's setup to the right, and a low shoulder. */
function ridge(x: number): number {
  const u = x / W;
  const peak = (centre: number, width: number, height: number) => height * Math.exp(-((u - centre) ** 2) / (2 * width * width));
  return Math.max(peak(0.4, 0.13, 0.8), peak(0.71, 0.075, 0.44), peak(0.12, 0.1, 0.36), 0.14) * H;
}

/** Where the bar sits, measured up from the ground. */
const BAR = H * 0.56;

/** The two peaks a pin can stand on. */
export const PEAKS = { winner: 0.4 * W, team: 0.71 * W };

/** A tile, and when its colour comes in, in seconds after the page loads. */
interface Tile { x: number; y: number; tone: string; delay: number }

function ridgeTiles(): Tile[][] {
  const random = seeded(hashString("bakeoff ridge"));
  const rows: Tile[][] = [];
  for (let c = 0; c * PITCH < W; c++) {
    const x = c * PITCH;
    const top = ridge(x + PITCH / 2) + (random() - 0.5) * 10;
    const count = Math.max(1, Math.floor(top / PITCH));
    for (let r = 0; r < count; r++) {
      if (random() < 0.07) continue;
      const depth = count - 1 - r;
      const y = H - (r + 1) * PITCH;
      const above = H - y > BAR;
      const roll = random();
      const tone = depth === 0 && roll < 0.7 ? "snow"
        : depth === 1 && roll < 0.35 ? "snow"
        : above ? (roll < 0.72 ? "gold" : roll < 0.9 ? "snow" : "stone")
        : roll < 0.4 ? "green" : roll < 0.72 ? "stone" : roll < 0.9 ? "sage" : "gold";
      // The tiles build in a blank colour; each then takes its own, drifting left to right.
      const delay = 0.9 + (x / W) * 0.8 + random() * 1.8;
      (rows[r] ??= []).push({ x, y, tone, delay });
    }
  }
  return rows;
}

const TILES = ridgeTiles().flat();

/** One tile as a rounded square in path data, so a whole layer of tiles is a single element. */
function tilePath({ x, y }: Tile): string {
  const side = SIZE - 4;
  return `M${x + 3} ${y + 1}h${side}a2 2 0 0 1 2 2v${side}a2 2 0 0 1-2 2h-${side}a2 2 0 0 1-2-2v-${side}a2 2 0 0 1 2-2z`;
}

/**
 * The tiles in colour, in layers by when they come in. Each layer is its own element whose opacity
 * the compositor animates over the blank tiles, so the colour drifting in repaints nothing.
 */
const COLOUR_LAYERS = 8;
const LAYERS = (() => {
  const first = Math.min(...TILES.map((t) => t.delay));
  const span = Math.max(...TILES.map((t) => t.delay)) - first;
  const layers = Array.from({ length: COLOUR_LAYERS }, (_, k) => ({ delay: first + (span * (k + 0.5)) / COLOUR_LAYERS, tones: new Map<string, string>() }));
  for (const t of TILES) {
    const layer = layers[Math.min(COLOUR_LAYERS - 1, Math.floor(((t.delay - first) / span) * COLOUR_LAYERS))]!;
    layer.tones.set(t.tone, (layer.tones.get(t.tone) ?? "") + tilePath(t));
  }
  return layers;
})();
const BLANK = TILES.map(tilePath).join("");

/** Lines that rise from the ground to points on the ridge, like routes to a summit. */
const ROUTES: [number, number][] = [[90, 300], [300, 520], [470, 600], [760, 590], [930, 1000], [1300, 1060]];

export interface Pin { x: number; text: string; tone: "gold" | "muted"; lift: number }

/** A label standing on the ridge at x, on a stem `lift` units tall. */
function RidgePin({ pin }: { pin: Pin }) {
  const top = H - ridge(pin.x);
  const width = pin.text.length * 7.4 + 26;
  const y = top - pin.lift;
  return (
    <g className={`ridge-pin ridge-pin-${pin.tone}`}>
      <path d={`M${pin.x} ${top - 2}V${y}`} />
      <circle cx={pin.x} cy={top - 2} r="3.5" />
      <rect x={pin.x - width / 2} y={y - 28} width={width} height="28" rx="14" />
      <text x={pin.x} y={y - 10} textAnchor="middle">{pin.text}</text>
    </g>
  );
}

/** A layer of the band: every layer shares the viewBox and sizing, so they line up exactly. */
function Layer({ className, style, children }: { className: string; style?: CSSProperties; children: React.ReactNode }) {
  return <svg className={`ridge-art ${className}`} style={style} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">{children}</svg>;
}

/** The sky and the tiles, which never change after the first render. */
const RidgeTiles = memo(function RidgeTiles() {
  return (
    <>
      <Layer className="ridge-sky">
        <defs>
          <linearGradient id="ridge-sky" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" style={{ stopColor: "var(--ridge-sky-a)" }} />
            <stop offset="0.62" style={{ stopColor: "var(--ridge-sky-b)" }} />
            <stop offset="1" style={{ stopColor: "var(--ridge-sky-c)" }} />
          </linearGradient>
        </defs>
        <rect width={W} height={H} fill="url(#ridge-sky)" />
      </Layer>
      <Layer className="ridge-layer ridge-blank-layer"><path d={BLANK} className="ridge-blank" /></Layer>
      {LAYERS.map((layer, k) => (
        <Layer key={k} className="ridge-layer ridge-tone-layer" style={{ "--d": `${layer.delay.toFixed(2)}s` } as CSSProperties}>
          {[...layer.tones].map(([tone, d]) => <path key={tone} d={d} className={`ridge-${tone}`} />)}
        </Layer>
      ))}
    </>
  );
});

/**
 * The hero's band, and a chart of the latest win: a ridge of ticket tiles
 * under a dashed bar. The tiles rise in blank, then their colours drift in
 * from left to right and stay. The winner's peak rises past the bar and turns
 * gold; the team's own setup stays under it. Pins label each peak when there
 * is a result to show, and the bar names the requirements.
 *
 * Each moving part is a layer of its own animated only by opacity and
 * transform, so the intro runs on the compositor and never repaints the band.
 */
export function RidgeArt({ pins = [], bar = "the bar" }: { pins?: Pin[]; bar?: string }) {
  return (
    <>
      <RidgeTiles />
      <Layer className="ridge-lines">
        <path d={`M0 ${H - BAR}H${W}`} className="ridge-bar" />
        <text x="24" y={H - BAR - 9} className="ridge-bar-label">{bar}</text>
        {ROUTES.map(([from, to]) => {
          const y = H - ridge(to) + 6;
          return (
            <g key={`${from}-${to}`} className="ridge-route">
              <path d={`M${from} ${H}L${to} ${y}`} />
              <circle cx={to} cy={y} r="3.2" />
            </g>
          );
        })}
      </Layer>
      {pins.length > 0 && <Layer className="ridge-pins">{pins.map((pin) => <RidgePin key={pin.text} pin={pin} />)}</Layer>}
    </>
  );
}

/** Labels for the ridge: the winner on the peak that clears the bar, the team's own setup on the one that doesn't. */
export function ridgeLabels(win: ChallengeSummary | null): { pins: Pin[]; bar: string } {
  const gates = win?.view ? challengeGates(win.view) : null;
  if (!win?.view?.award || !win.winner || !gates) return { pins: [], bar: "the bar" };
  const m = win.winner;
  const base = win.listing.baseline;
  const misses = [
    base.accuracy_bp < gates.min_accuracy_bp && percent(base.accuracy_bp),
    base.cost_per_ticket_uusd > gates.max_cost_per_ticket_uusd && `${microDollars(base.cost_per_ticket_uusd)} a ticket`,
    base.p95_latency_ms > gates.max_p95_latency_ms && `${seconds(base.p95_latency_ms)} p95`,
  ].filter(Boolean);
  return {
    pins: [
      { x: PEAKS.winner, text: `#1 ${win.view.award.winner} · ${percent(m.accuracy_bp)} · ${microDollars(m.cost_per_ticket_uusd)}`, tone: "gold", lift: 26 },
      { x: PEAKS.team, text: `Team's current setup${misses.length ? ` · ${misses.join(", ")}` : ""}`, tone: "muted", lift: 54 },
    ],
    bar: `the bar · ≥ ${percent(gates.min_accuracy_bp)} · ≤ ${microDollars(gates.max_cost_per_ticket_uusd)} · ≤ ${seconds(gates.max_p95_latency_ms)} · ${gates.max_leaks === 0 ? "no card numbers" : `≤ ${gates.max_leaks} leaks`}`,
  };
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
type Cell = "." | "o" | "g" | Icon | string;

/** The tile wall, row by row: "." empty, "o" a plain tile, "g" a gold one, else a raised tile with an icon or label. */
const WALL: Cell[][] = [
  [".", "o", "MCP", "o", "g", "o", "o"],
  ["o", Bot, "o", "o", "o", Lock, "o"],
  ["o", "o", "g", "›_", "o", "o", "o"],
  ["o", Coins, "o", "o", "o", "g", Cube],
  [Sparkle, "o", "o", Shield, "o", "o", "o"],
];

/** The agents band's wall of tiles, with what an agent works through raised out of it, lighting up in turn. */
export function AgentTiles() {
  let raised = 0;
  return (
    <div className="wall" aria-hidden="true">
      {WALL.flatMap((row, r) => row.map((cell, c) => {
        if (cell === ".") return null;
        const place = { gridRow: r + 1, gridColumn: c + 1 };
        if (cell === "o" || cell === "g") return <span key={`${r}:${c}`} className={`wall-tile ${cell === "g" ? "wall-gold" : ""}`} style={place} />;
        const Mark = cell;
        const k = raised++;
        return (
          <motion.span
            key={`${r}:${c}`}
            className="wall-tile wall-raised"
            style={{ ...place, "--k": k } as React.CSSProperties}
            initial={{ opacity: 0, transform: "translateY(8px)" }}
            whileInView={{ opacity: 1, transform: "translateY(0px)" }}
            viewport={{ once: true, margin: "-10% 0px" }}
            transition={{ delay: (r + c) * 0.035, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            {typeof Mark === "string" ? <span className="wall-label">{Mark}</span> : <Mark />}
          </motion.span>
        );
      }))}
    </div>
  );
}

/** The MCP tools an agent calls on its way to a submission, in order. */
const SESSION = [
  ["list_challenges", "finds the open challenge"],
  ["get_challenge", "reads the rules and requirements"],
  ["get_practice_tickets", "the public practice tickets"],
  ["score_on_practice", "tries an idea with the pinned evaluator"],
  ["submit_candidate", "asks you, then submits once"],
] as const;

/** An agent's session through Bakeoff's MCP server, ending on the latest result when there is one. */
export function AgentSession({ outcome }: { outcome: string | null }) {
  const step = (i: number) => ({
    initial: { opacity: 0, transform: "translateX(-6px)" },
    whileInView: { opacity: 1, transform: "translateX(0px)" },
    viewport: { once: true, margin: "-10% 0px" },
    transition: { delay: 0.3 + i * 0.32, duration: 0.35, ease: [0.22, 1, 0.36, 1] as const },
  });
  return (
    <div className="session" role="img" aria-label={`An agent's session: ${SESSION.map(([tool]) => tool).join(", ")}${outcome ? `, then ${outcome}` : ""}`}>
      <div className="session-head" aria-hidden="true">
        <span className="session-dots"><i /><i /><i /></span>
        <span>claude · bakeoff MCP</span>
      </div>
      <p className="session-prompt" aria-hidden="true"><span>›</span> Find the open Bakeoff challenge and try to win it.</p>
      <ol aria-hidden="true">
        {SESSION.map(([tool, note], i) => (
          <motion.li key={tool} {...step(i)}>
            <span className="session-tool">{tool}</span>
            <span className="session-note">{note}</span>
          </motion.li>
        ))}
        {outcome && (
          <motion.li className="session-done" {...step(SESSION.length)}>
            <Check />
            <span>{outcome}</span>
          </motion.li>
        )}
      </ol>
    </div>
  );
}
