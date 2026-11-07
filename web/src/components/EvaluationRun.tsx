/**
 * The home page's hero panel: the latest winning result, replayed as the
 * sealed run that produced it. Each square is a hidden ticket. The run only
 * ever reports totals, so the squares fill in order rather than per ticket.
 */

import { animate } from "motion/react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ChallengeSummary } from "../lib/data.ts";
import { microDollars, percent, seconds } from "../lib/format.ts";
import { usePrefersReducedMotion } from "../lib/hooks.ts";
import { challengeGates, formatNear } from "../lib/near.ts";
import { checkRequirements } from "../lib/results.ts";
import { ArrowRight, Check, Coins, Lock, Replay } from "./Icons.tsx";

type Phase = "sealed" | "scoring" | "scored" | "checked" | "paid";
const ORDER: Phase[] = ["sealed", "scoring", "scored", "checked", "paid"];

/** Milliseconds per ticket while the run scores; the CSS staggers by the same step. */
const STEP_MS = 18;

function useRun(tickets: number, ready: boolean, reduced: boolean) {
  const [phase, setPhase] = useState<Phase>(reduced ? "paid" : "sealed");
  const [scored, setScored] = useState(reduced ? tickets : 0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (!ready) return;
    if (reduced) {
      setPhase("paid");
      setScored(tickets);
      return;
    }
    setPhase("sealed");
    setScored(0);
    const scoringFor = tickets * STEP_MS;
    const at: [number, Phase][] = [[350, "scoring"], [350 + scoringFor + 250, "scored"], [350 + scoringFor + 850, "checked"], [350 + scoringFor + 1900, "paid"]];
    const timers = at.map(([ms, next]) => setTimeout(() => setPhase(next), ms));
    let stop = () => {};
    timers.push(setTimeout(() => {
      stop = animate(0, tickets, { duration: scoringFor / 1000, ease: "linear", onUpdate: (v) => setScored(Math.round(v)) }).stop;
    }, 350));
    return () => {
      timers.forEach(clearTimeout);
      stop();
    };
  }, [ready, reduced, tickets, run]);

  const reached = (p: Phase) => ORDER.indexOf(phase) >= ORDER.indexOf(p);
  return { phase, scored, reached, replay: () => setRun((n) => n + 1) };
}

export function EvaluationRun({ win, loading }: { win: ChallengeSummary | null; loading: boolean }) {
  const reduced = usePrefersReducedMotion();
  const metrics = win?.winner ?? null;
  const view = win?.view ?? null;
  const gates = view ? challengeGates(view) : null;
  const tickets = metrics?.tickets ?? win?.listing.tickets ?? 100;
  const correct = metrics?.accuracy_bp !== undefined ? Math.round((metrics.accuracy_bp / 10_000) * tickets) : 0;
  const ready = Boolean(win && metrics && gates && view?.award);
  const { phase, scored, reached, replay } = useRun(tickets, ready, reduced);
  const checks = win && gates ? checkRequirements(gates, metrics, win.listing.baseline, { percent, micro: microDollars, seconds }) : [];

  const status = !ready
    ? loading ? "Reading the chain…" : "No result has met every requirement yet"
    : phase === "sealed" ? "Sealed"
    : phase === "scoring" ? `Scoring ${scored}/${tickets}`
    : reached("paid") ? "Passed"
    : `${correct} of ${tickets} correct`;

  return (
    <div className={`run ${ORDER.slice(1).filter(reached).map((p) => `is-${p}`).join(" ")}`} data-ready={ready || undefined}>
      <div className="run-head">
        <span className="run-title">
          <Lock />
          <span>Hidden test{win && view?.award ? <span className="muted"> · result #{view.award.evaluation}{win.listing.demo ? " · demo" : ""}</span> : null}</span>
        </span>
        {ready && reached("paid")
          ? <span className="badge badge-dot badge-green run-passed" aria-live="polite">{status}</span>
          : <span className={`run-status mono ${phase === "scoring" ? "shimmer-text" : ""}`} aria-live="polite">{status}</span>}
      </div>

      <div className="run-grid" style={{ "--cols": Math.min(20, Math.ceil(tickets / 5)) } as React.CSSProperties} aria-hidden="true">
        {Array.from({ length: tickets }, (_, i) => <span key={i} className={`run-mark ${i < correct ? "hit" : ""}`} style={{ "--i": i } as React.CSSProperties} />)}
      </div>
      <p className="run-caption">
        {reached("scored") && ready
          ? <>{correct} of {tickets} hidden tickets answered correctly. Only totals leave the enclave, so which ones stays sealed.</>
          : <>{tickets} hidden tickets, scored once inside an OutLayer enclave.</>}
      </p>

      <ul className="run-checks" aria-label="Requirements">
        {(checks.length ? checks : PLACEHOLDER_CHECKS).map((c, i) => (
          <li key={c.label} className={c.met ? "met" : ""} style={{ "--i": i } as React.CSSProperties}>
            <span className="run-check-label">{c.label}</span>
            <span className="run-check-value mono">{reached("checked") ? c.value : "–"}</span>
            <span className="run-check-needed mono muted">{c.needed}</span>
            <span className="run-check-icon"><Check /></span>
          </li>
        ))}
      </ul>

      <div className="run-foot">
        {ready && win && view?.award ? (
          <>
            <span className="run-paid"><Coins /> Contract paid <strong className="amber">{formatNear(view.award.amount)}</strong></span>
            <span className="run-actions">
              <button type="button" className="icon-btn" onClick={replay} aria-label="Replay the run" title="Replay the run" disabled={!reached("paid")}><Replay /></button>
              <Link to={`/challenges/${win.listing.id}/results/${view.award.evaluation}`} className="btn btn-sm">See the result <ArrowRight /></Link>
            </span>
          </>
        ) : <span className="muted small">Results are read from NEAR.</span>}
      </div>
    </div>
  );
}

const PLACEHOLDER_CHECKS = ["Accuracy", "Cost per ticket", "p95 latency", "Card numbers repeated"].map((label) => ({ label, needed: "", value: "–", met: null }));
