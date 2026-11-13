/**
 * The footer's wordmark, spelled in tiles like the ridge behind the hero.
 *
 * The tiles start the colour of raw dough. When the footer scrolls into view
 * they rise and bake from left to right: gold where the letters climb above
 * the bar, the brand's greens below it with a golden crust on top, as on the
 * ridge. After that a tile glows now and then, and tiles under the pointer
 * heat up and slowly cool. Phones get a coarser cut of the same word, one
 * tile per pixel of a letter, so the tiles stay big enough to read.
 */

import type { CSSProperties } from "react";
import { useInView, usePrefersReducedMotion } from "../lib/hooks.ts";
import { hashString, seeded } from "./art.tsx";

/** The letters, seven rows each. The top two rows are ascenders, which stand above the bar. */
const GLYPHS: Record<string, string[]> = {
  b: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
  a: [".....", ".....", ".###.", "....#", "#####", "#...#", ".####"],
  k: ["#...", "#...", "#..#", "#.#.", "##..", "#.#.", "#..#"],
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".####"],
  o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  f: ["..##", ".#..", "####", ".#..", ".#..", ".#..", ".#.."],
};

const WORD = "bakeoff";
const PITCH = 16;
const SIZE = 13;
/** How many tiles glow in turn once the word has baked, and how far apart. */
const SPARKS = 9;
const SPARK_GAP = 1.6;

interface Tile { x: number; y: number; tone: string; delay: number }
interface Art { tiles: Tile[]; sparks: Tile[]; width: number; height: number; bar: number }

/** The word with each pixel of a letter drawn as split × split tiles. */
function layout(split: number): Art {
  /** Tiles in rows above this one are above the bar. */
  const barRow = 2 * split;
  const random = seeded(hashString("bakeoff footer"));
  const cells: [number, number][] = [];
  let col = 0;
  for (const letter of WORD) {
    const glyph = GLYPHS[letter]!;
    glyph.forEach((line, r) => [...line].forEach((pixel, c) => {
      if (pixel !== "#") return;
      for (let dy = 0; dy < split; dy++) for (let dx = 0; dx < split; dx++) cells.push([col + c * split + dx, r * split + dy]);
    }));
    col += (glyph[0]!.length + 1) * split;
  }
  const columns = col - split;
  const filled = new Set(cells.map(([c, r]) => `${c},${r}`));
  const tiles = cells.map(([c, r]): Tile => {
    const roll = random();
    const crust = !filled.has(`${c},${r - 1}`);
    const tone = r < barRow ? (roll < 0.78 ? "gold" : "green")
      : crust && roll < 0.6 ? "gold"
      : roll < 0.56 ? "green" : roll < 0.78 ? "sage" : "gold";
    // The word bakes left to right, each tile a little before or after its neighbours.
    return { x: c * PITCH, y: r * PITCH, tone, delay: 0.1 + (c / columns) * 1.1 + random() * 0.9 };
  });
  // Tiles that glow in turn, spread along the word, starting once it has baked.
  const sparks = Array.from({ length: SPARKS }, (_, i) => {
    const pool = tiles.filter((t) => Math.floor((t.x / PITCH / columns) * SPARKS) === i);
    const tile = pool[Math.floor(random() * pool.length)]!;
    return { ...tile, delay: 2.6 + ((i * 4) % SPARKS) * SPARK_GAP };
  });
  const gap = PITCH - SIZE;
  return { tiles, sparks, width: columns * PITCH - gap, height: 7 * split * PITCH - gap, bar: barRow * PITCH - gap / 2 };
}

const FINE = layout(2);
const COARSE = layout(1);

function Word({ art, className }: { art: Art; className: string }) {
  return (
    <svg className={className} viewBox={`0 0 ${art.width} ${art.height}`} focusable="false">
      {art.tiles.map((t) => (
        <rect key={`${t.x},${t.y}`} x={t.x} y={t.y} width={SIZE} height={SIZE} rx="3" className={`fw-tile ridge-${t.tone}`} style={{ "--d": `${t.delay.toFixed(2)}s` } as CSSProperties} />
      ))}
      <path d={`M0 ${art.bar}H${art.width}`} className="fw-bar" />
      <text x={5 * PITCH} y={art.bar - 10} className="fw-bar-label">the bar</text>
      {art.sparks.map((t) => (
        <rect key={`spark-${t.x},${t.y}`} x={t.x} y={t.y} width={SIZE} height={SIZE} rx="3" className="fw-spark" style={{ "--d": `${t.delay.toFixed(2)}s` } as CSSProperties} />
      ))}
    </svg>
  );
}

export function FooterWordmark() {
  const reduced = usePrefersReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>("0px 0px -8% 0px");
  return (
    <div
      ref={ref}
      className={`fw${seen ? " baked" : ""}${reduced ? " still" : ""}`}
      style={{ "--cycle": `${SPARKS * SPARK_GAP}s` } as CSSProperties}
      aria-hidden="true"
    >
      <Word art={FINE} className="fw-art fw-fine" />
      <Word art={COARSE} className="fw-art fw-coarse" />
    </div>
  );
}
