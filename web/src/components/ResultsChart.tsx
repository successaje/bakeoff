/**
 * Every scored result by cost and accuracy, with the area that meets both
 * requirements shaded and the team's baseline marked. Shape and colour both
 * say how a result did, and the leaderboard's table holds every figure.
 */

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useHref, useNavigate } from "react-router";
import { accuracyTick, chartAxes, labelWidth, linear, placeLabel, type Placed, plotResults, type Point, type Spot } from "../lib/chart.ts";
import { microDollars, percent, seconds } from "../lib/format.ts";
import { usePrefersReducedMotion } from "../lib/hooks.ts";
import type { EvaluationView, Gates } from "../lib/near.ts";
import type { Baseline } from "../lib/registry.ts";
import { reasonText } from "./challenge.tsx";

const MARGIN = { top: 30, right: 20, bottom: 46, left: 50 };
/** Half the tooltip's widest, so it never runs past either edge of the plot. */
const TIP_HALF = 112;

/** The element's width, kept current, so the text inside the chart stays at its real size. */
function useWidth<T extends Element>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function outcomeText(p: Point): string {
  if (p.outcome === "winner") return "Won the reward";
  if (p.outcome === "passed") return "Met every requirement";
  return p.reasons.length ? `Failed: ${p.reasons.map(reasonText).join(", ")}` : "Failed";
}

function describe(p: Point): string {
  const who = `${p.submitter}${p.trial ? ", the owner's trial" : ""}`;
  return `Result #${p.id} by ${who}. ${outcomeText(p)}. ${percent(p.accuracy)} accuracy, ${microDollars(p.cost)} per ticket, ${seconds(p.p95)} p95.`;
}

/** The mark for one result: a dot for a pass, a cross for a failure, a hollow square for an owner's trial. */
function Mark({ p, cx, cy }: { p: Point; cx: number; cy: number }) {
  if (p.trial) {
    return (
      <>
        <rect className="rc-ring" x={cx - 7} y={cy - 7} width={14} height={14} rx={3} />
        <rect className="rc-trial" x={cx - 4.5} y={cy - 4.5} width={9} height={9} rx={1.5} />
      </>
    );
  }
  if (p.outcome === "failed") {
    const d = `M${cx - 4},${cy - 4}L${cx + 4},${cy + 4}M${cx + 4},${cy - 4}L${cx - 4},${cy + 4}`;
    return (
      <>
        <path className="rc-cross-ring" d={d} />
        <path className="rc-cross" d={d} />
      </>
    );
  }
  const winner = p.outcome === "winner";
  return (
    <>
      {winner && <circle className="rc-halo" cx={cx} cy={cy} r={13} />}
      <circle className="rc-ring" cx={cx} cy={cy} r={winner ? 9 : 7} />
      <circle className="rc-dot" cx={cx} cy={cy} r={winner ? 7 : 5} />
    </>
  );
}

function LegendKey({ kind }: { kind: "pass" | "fail" | "trial" | "baseline" | "area" }) {
  return (
    <svg className="rc-key" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {kind === "pass" && <circle className="rc-dot" cx="7" cy="7" r="5" />}
      {kind === "fail" && <path className="rc-cross" d="M3,3L11,11M11,3L3,11" />}
      {kind === "trial" && <rect className="rc-trial" x="2.5" y="2.5" width="9" height="9" rx="1.5" />}
      {kind === "baseline" && <path className="rc-baseline" d="M7,1L13,7L7,13L1,7Z" />}
      {kind === "area" && <rect className="rc-area-key" x="1" y="1" width="12" height="12" rx="2" />}
    </svg>
  );
}

export function ResultsChart({ challenge, evaluations, owner, awarded, gates, baseline, match, onShowTable }: {
  challenge: string;
  evaluations: EvaluationView[];
  owner: string;
  awarded: number | null;
  gates: Gates | null;
  baseline: Baseline | null;
  /** The builders a search has narrowed the page to; the others' results are not drawn. */
  match?: (account: string) => boolean;
  onShowTable?: () => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(720);
  const navigate = useNavigate();
  const base = useHref(`/challenges/${challenge}/results/`);
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const plotted = useMemo(() => plotResults(evaluations, owner, awarded), [evaluations, owner, awarded]);
  const marked = baseline && baseline.cost_per_ticket_uusd > 0 && baseline.accuracy_bp > 0 ? baseline : null;
  const axes = useMemo(() => chartAxes(plotted.points, gates, marked), [plotted, gates, marked]);
  if (plotted.points.length === 0 && !gates && !marked) return null;

  const narrow = width < 520;
  const height = narrow ? 270 : 330;
  const right = width - MARGIN.right;
  const bottom = height - MARGIN.bottom;
  const x = linear(axes.cost.domain, [MARGIN.left, right]);
  const y = linear(axes.accuracy.domain, [bottom, MARGIN.top]);
  const shown = match ? plotted.points.filter((p) => match(p.submitter)) : plotted.points;
  const current = shown.find((p) => p.id === active) ?? null;
  const hasTrial = plotted.points.some((p) => p.trial);

  const area = gates && { x1: x(gates.max_cost_per_ticket_uusd), y1: y(gates.min_accuracy_bp) };
  const areaWidth = area ? area.x1 - MARGIN.left : 0;

  // Two direct labels at most, the winner and the baseline, each kept clear of the other marks.
  const spots = new Map<number, Spot>(shown.map((p) => [p.id, { x: x(p.cost), y: y(p.accuracy) }]));
  const baseSpot = marked ? { x: x(marked.cost_per_ticket_uusd), y: y(marked.accuracy_bp) } : null;
  const bounds = { left: MARGIN.left, right: width - 2, top: MARGIN.top, bottom };
  const winner = shown.find((p) => p.outcome === "winner");
  const winnerLabel = winner ? placeLabel(spots.get(winner.id)!, labelWidth("Winner"), 17, [...shown.filter((p) => p !== winner).map((p) => spots.get(p.id)!), ...(baseSpot ? [baseSpot] : [])], bounds) : null;
  const baseLabel = baseSpot ? placeLabel(baseSpot, labelWidth("Baseline"), 13, [...spots.values()], bounds) : null;
  const textAt = (placed: Placed) => ({ x: placed.x, y: placed.y, textAnchor: placed.anchor, dominantBaseline: "middle" as const });

  const left = [
    plotted.scoring && `${plotted.scoring} still scoring`,
    plotted.rejected && `${plotted.rejected} rejected`,
    plotted.unscored && `${plotted.unscored} with no figures`,
  ].filter(Boolean);
  const count = match ? `${shown.length} of ${plotted.points.length} results shown.` : `${plotted.points.length} result${plotted.points.length === 1 ? "" : "s"} plotted.`;

  return (
    <section className="card card-pad results-chart" aria-labelledby="results-chart-title">
      <div className="rc-head">
        <div>
          <h2 id="results-chart-title">Results by cost and accuracy</h2>
          <p className="muted small">Cheaper is further left, more accurate is higher. Each mark opens its result.</p>
        </div>
        <ul className="legend rc-legend" aria-label="Key">
          <li><LegendKey kind="pass" /> Met every requirement</li>
          <li><LegendKey kind="fail" /> Failed</li>
          {hasTrial && <li><LegendKey kind="trial" /> Owner's trial</li>}
          {marked && <li><LegendKey kind="baseline" /> Baseline</li>}
          {gates && <li><LegendKey kind="area" /> Meets accuracy and cost</li>}
        </ul>
      </div>

      <div className="rc-plot" ref={ref}>
        <svg width={width} height={height} role="group" aria-labelledby="results-chart-title" aria-describedby="results-chart-note">
          <g className="rc-grid" aria-hidden="true">
            {axes.accuracy.ticks.map((t) => <line key={`y${t}`} x1={MARGIN.left} x2={right} y1={y(t)} y2={y(t)} />)}
            {axes.cost.ticks.map((t) => <line key={`x${t}`} x1={x(t)} x2={x(t)} y1={MARGIN.top} y2={bottom} />)}
          </g>

          {area && (
            <g aria-hidden="true">
              <rect className="rc-area" x={MARGIN.left} y={MARGIN.top} width={Math.max(0, areaWidth)} height={Math.max(0, area.y1 - MARGIN.top)} />
              <line className="rc-gate" x1={area.x1} x2={area.x1} y1={MARGIN.top} y2={area.y1} />
              <line className="rc-gate" x1={MARGIN.left} x2={area.x1} y1={area.y1} y2={area.y1} />
              {areaWidth >= 150 && area.y1 - MARGIN.top >= 44 && (
                <text className="rc-area-label" x={MARGIN.left + 10} y={MARGIN.top + 18}>
                  <tspan>Meets accuracy and cost</tspan>
                  <tspan className="rc-area-sub" x={MARGIN.left + 10} dy="16">≥ {percent(gates.min_accuracy_bp)} · ≤ {microDollars(gates.max_cost_per_ticket_uusd)}</tspan>
                </text>
              )}
            </g>
          )}

          <g className="rc-axis" aria-hidden="true">
            {axes.accuracy.ticks.map((t) => <text key={`y${t}`} x={MARGIN.left - 10} y={y(t)} textAnchor="end" dominantBaseline="middle">{accuracyTick(t, axes.accuracy.step)}</text>)}
            {axes.cost.ticks.map((t) => <text key={`x${t}`} x={x(t)} y={bottom + 18} textAnchor="middle">{t}</text>)}
            <text className="rc-axis-title" x={MARGIN.left - 10} y={MARGIN.top - 14} textAnchor="start">Accuracy</text>
            <text className="rc-axis-title" x={right} y={height - 6} textAnchor="end">Cost per ticket, µ$</text>
          </g>

          {marked && (
            <g className="rc-baseline-mark" aria-hidden="true">
              <path className="rc-ring" d={diamond(baseSpot!.x, baseSpot!.y, 10)} />
              <path className="rc-baseline" d={diamond(baseSpot!.x, baseSpot!.y, 7)} />
              {baseLabel && <text className="rc-label" {...textAt(baseLabel)}>Baseline</text>}
            </g>
          )}

          {plotted.points.length === 0 && (
            <text className="rc-empty" x={(MARGIN.left + right) / 2} y={(MARGIN.top + bottom) / 2} textAnchor="middle">No scored results yet</text>
          )}

          {shown.map((p, i) => {
            const cx = x(p.cost);
            const cy = y(p.accuracy);
            const path = `/challenges/${challenge}/results/${p.id}`;
            const release = () => setActive((a) => (a === p.id ? null : a));
            return (
              <a
                key={p.id}
                href={`${base}${p.id}`}
                className={`rc-point ${active === p.id ? "active" : ""}`}
                aria-label={describe(p)}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                  event.preventDefault();
                  navigate(path);
                }}
                onPointerEnter={() => setActive(p.id)}
                onPointerLeave={release}
                onFocus={() => setActive(p.id)}
                onBlur={release}
              >
                <motion.g initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 + i * 0.03, duration: 0.3 }}>
                  <circle className="rc-hit" cx={cx} cy={cy} r={12} />
                  <Mark p={p} cx={cx} cy={cy} />
                  {p === winner && winnerLabel && <text className="rc-label rc-label-strong" {...textAt(winnerLabel)}>Winner</text>}
                </motion.g>
              </a>
            );
          })}
        </svg>

        {current && (
          <div
            className={`rc-tip ${y(current.accuracy) < 120 ? "below" : ""}`}
            style={{ left: Math.min(Math.max(x(current.cost), TIP_HALF), width - TIP_HALF), top: y(current.accuracy) }}
            aria-hidden="true"
          >
            <strong>{percent(current.accuracy)} · {microDollars(current.cost)}</strong>
            <span className="muted">p95 {seconds(current.p95)} · {current.leaks ?? "–"} card number{current.leaks === 1 ? "" : "s"} repeated</span>
            <span className="rc-tip-who">{current.submitter} · #{current.id}{current.trial ? " · Owner's trial" : ""}</span>
            <span>{outcomeText(current)}</span>
          </div>
        )}
      </div>

      <p className="muted small rc-note" id="results-chart-note">
        {count} A result must also answer in time and repeat no card numbers, so one can fail inside the shaded area.
        {left.length > 0 && <> Not plotted: {left.join(", ")}.</>}
        {onShowTable && <> <button type="button" className="link-button" onClick={onShowTable}>See every result as a table</button></>}
      </p>
    </section>
  );
}

function diamond(cx: number, cy: number, r: number): string {
  return `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;
}
