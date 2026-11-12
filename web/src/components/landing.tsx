/**
 * Artwork for the landing page, drawn in code from a fixed seed: the ridge
 * behind the hero, the tile wall in the agents band, and the stack of cards
 * that carries the live counts. Colours come from theme tokens, so each
 * piece reads in light and dark.
 */

import { motion } from "motion/react";
import type { ComponentType, SVGProps } from "react";
import { hashString, seeded } from "./art.tsx";
import { Bot, Coins, Cube, Lock, Shield, Sparkle } from "./Icons.tsx";

const W = 1440;
const H = 320;
const PITCH = 12;
const SIZE = 10;

/** Height of the ridge at x: a main peak, a second one to the right, and a low shoulder. */
function ridge(x: number): number {
  const u = x / W;
  const peak = (centre: number, width: number, height: number) => height * Math.exp(-((u - centre) ** 2) / (2 * width * width));
  return Math.max(peak(0.4, 0.13, 0.94), peak(0.8, 0.085, 0.6), peak(0.12, 0.1, 0.4), 0.14) * H;
}

const BAR = H * 0.56;

interface Tile { x: number; y: number; tone: string }

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
      (rows[r] ??= []).push({ x, y, tone });
    }
  }
  return rows;
}

const TILES = ridgeTiles();

/** Lines that rise from the ground to points on the ridge, like routes to a summit. */
const ROUTES: [number, number][] = [[90, 300], [300, 520], [470, 600], [760, 590], [1010, 1150], [1300, 1180]];

/**
 * The hero's band: a ridge of ticket tiles under a dashed bar. The tiles that
 * rise past the bar are gold, the ones that cleared it.
 */
export function RidgeArt() {
  return (
    <svg className="ridge-art" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id="ridge-sky" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" style={{ stopColor: "var(--ridge-sky-a)" }} />
          <stop offset="0.62" style={{ stopColor: "var(--ridge-sky-b)" }} />
          <stop offset="1" style={{ stopColor: "var(--ridge-sky-c)" }} />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill="url(#ridge-sky)" />
      {TILES.map((row, r) => (
        <g key={r} className="ridge-row" style={{ "--r": r } as React.CSSProperties}>
          {row.map((t) => <rect key={t.x} x={t.x + 1} y={t.y + 1} width={SIZE} height={SIZE} rx="2" className={`ridge-${t.tone}`} />)}
        </g>
      ))}
      <path d={`M0 ${H - BAR}H${W}`} className="ridge-bar" />
      <text x="24" y={H - BAR - 8} className="ridge-bar-label">the bar</text>
      {ROUTES.map(([from, to]) => {
        const y = H - ridge(to) + 6;
        return (
          <g key={`${from}-${to}`} className="ridge-route">
            <path d={`M${from} ${H}L${to} ${y}`} />
            <circle cx={to} cy={y} r="3.2" />
          </g>
        );
      })}
    </svg>
  );
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
type Cell = "." | "o" | "g" | Icon | string;

/** The tile wall, row by row: "." empty, "o" a plain tile, "g" a gold one, else a raised tile with an icon or label. */
const WALL: Cell[][] = [
  [".", ".", ".", ".", ".", "o", "o", "MCP", "o", "g", "o", "o"],
  [".", ".", ".", ".", ".", "o", Bot, "o", "o", "o", Lock, "o"],
  [".", ".", ".", ".", ".", "o", "o", "o", "o", "›_", "o", "o"],
  [".", ".", "o", "o", Coins, "o", "o", "g", "o", "o", "o", "o"],
  ["o", Sparkle, "o", "o", "o", "o", Cube, "o", "o", Shield, "o", "g"],
];

/** The agents band's wall of tiles, with what an agent works through raised out of it. */
export function AgentTiles() {
  return (
    <div className="wall" aria-hidden="true">
      {WALL.flatMap((row, r) => row.map((cell, c) => {
        if (cell === ".") return null;
        const place = { gridRow: r + 1, gridColumn: c + 1 };
        if (cell === "o" || cell === "g") return <span key={`${r}:${c}`} className={`wall-tile ${cell === "g" ? "wall-gold" : ""}`} style={place} />;
        const Mark = cell;
        return (
          <motion.span
            key={`${r}:${c}`}
            className="wall-tile wall-raised"
            style={place}
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
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

/** A rounded polygon: each corner is cut back by `r` along both edges and joined with a curve. */
function rounded(points: [number, number][], r: number): string {
  const n = points.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const [px, py] = points[(i - 1 + n) % n]!;
    const [x, y] = points[i]!;
    const [nx, ny] = points[(i + 1) % n]!;
    const toward = (ax: number, ay: number): [number, number] => {
      const len = Math.hypot(ax - x, ay - y);
      return [x + ((ax - x) / len) * r, y + ((ay - y) / len) * r];
    };
    const [ax, ay] = toward(px, py);
    const [bx, by] = toward(nx, ny);
    d += `${i === 0 ? "M" : "L"}${ax.toFixed(1)} ${ay.toFixed(1)}Q${x} ${y} ${bx.toFixed(1)} ${by.toFixed(1)}`;
  }
  return `${d}Z`;
}

/**
 * Four cards standing one behind another, each labelled with a live count,
 * the front card first in `labels`.
 */
export function StackArt({ labels }: { labels: string[] }) {
  const w = 230;
  const h = 260;
  const slope = 0.3;
  const angle = (Math.atan(-slope) * 180) / Math.PI;
  // Each card sits far enough up for its label to clear the top edge of the card in front.
  const cards = labels.map((label, i) => ({ label, x: 30 + i * 60, y: 290 - i * 70 })).reverse();
  return (
    <svg className="stack-art" viewBox="0 0 520 570" role="img" aria-label={labels.join(", ")}>
      {cards.map((card, i) => {
        const { x, y } = card;
        const path = rounded([[x, y], [x + w, y - w * slope], [x + w, y - w * slope + h], [x, y + h]], 14);
        return (
          <motion.g
            key={card.label}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-15% 0px" }}
            transition={{ delay: i * 0.1, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          >
            <path d={path} className="stack-card" />
            <text className="stack-label" transform={`translate(${x + 18} ${y + 30}) rotate(${angle})`}>{card.label}</text>
          </motion.g>
        );
      })}
    </svg>
  );
}
