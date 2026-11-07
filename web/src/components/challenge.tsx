import { motion } from "motion/react";
import { Link } from "react-router";
import type { ChallengeSummary } from "../lib/data.ts";
import { microDollars, percent, seconds, shortHash, utc } from "../lib/format.ts";
import { type EvaluationView, formatNear, type Gates, type Metrics, type Network, nsToDate, verdictMetrics, challengeGates } from "../lib/near.ts";
import type { Baseline } from "../lib/registry.ts";
import { useInView, usePrefersReducedMotion } from "../lib/hooks.ts";
import { ArrowRight, Coins, Timer } from "./Icons.tsx";
import { Account, Countdown, DemoBadge, displayStatus, StatusBadge } from "./ui.tsx";

/** What each verdict reason means, in the words a contributor would use. */
export const REASONS: Record<string, string> = {
  gate_accuracy: "Below the accuracy gate",
  gate_cost: "Above the cost gate",
  gate_latency: "Slower than the latency gate",
  gate_leaks: "Leaked a card number",
  policy_tool: "Asked for a tool the rules don't allow",
  policy_model: "Used a model the rules don't list",
  policy_limits: "Broke a limit in the rules",
  config_invalid: "The config could not be read",
  input_invalid: "The request could not be read",
  rules_invalid: "The rules could not be read",
  test_set_unavailable: "The sealed test set was not available",
  test_set_invalid: "The sealed test set could not be read",
  timeout: "Ran out of time",
  upstream_errors: "Too many model calls failed",
  rules_mismatch: "Scored under different rules",
  config_mismatch: "Scored a different config",
  test_set_mismatch: "Scored a different test set",
  execution_failed: "The enclave run failed",
  verdict_malformed: "The verdict could not be read",
  verdict_too_large: "The verdict was too large",
  outlayer_call_failed: "OutLayer could not be reached",
};

export const reasonText = (reason: string) => REASONS[reason] ?? reason.replace(/_/g, " ");

/** Cost saved against the baseline, as a whole percentage. */
export function costCut(baseline: Baseline, winner: Metrics | null): number | null {
  if (!winner?.cost_per_ticket_uusd || !baseline.cost_per_ticket_uusd) return null;
  return Math.round((1 - winner.cost_per_ticket_uusd / baseline.cost_per_ticket_uusd) * 100);
}

export function ChallengeCard({ summary, index = 0 }: { summary: ChallengeSummary; index?: number }) {
  const { listing, view, winner, error } = summary;
  const reduced = usePrefersReducedMotion();
  const gates = view ? challengeGates(view) : null;
  const cut = costCut(listing.baseline, winner);
  const status = view ? displayStatus(view) : null;
  return (
    <motion.article
      className="challenge-card card"
      initial={reduced ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.06, ease: [0.22, 1, 0.36, 1] }}
    >
      <Link to={`/challenges/${listing.id}`} className="challenge-card-link" aria-label={`${listing.title}, ${listing.sponsor}`}>
        <div className="challenge-card-top">
          <span className="card-owner"><span className="eyebrow-plain">{listing.sponsor}</span>{listing.demo && <DemoBadge />}</span>
          {view ? <StatusBadge view={view} /> : <span className="badge badge-coral">Unavailable</span>}
        </div>
        <h3>{listing.title}</h3>
        <p className="challenge-card-summary">{listing.summary}</p>
        {error && <p className="coral small">{error}</p>}
        {view && (
          <div className="challenge-card-stats">
            <div>
              <span className="label"><Coins /> {view.award ? (view.award.paid ? "Paid" : "Awarded") : "Bounty"}</span>
              <strong className="amber">{formatNear(view.award?.amount ?? view.bounty ?? "0")}</strong>
            </div>
            <div>
              <span className="label"><Timer /> {status === "open" ? "Closes in" : "Deadline"}</span>
              <strong>{status === "open" ? <Countdown closesAt={view.closes_at} /> : view.closes_at ? utc(nsToDate(view.closes_at)).slice(0, 10) : "Not open yet"}</strong>
            </div>
            <div>
              <span className="label">Verdicts</span>
              <strong className="tabular">{view.evaluations}</strong>
            </div>
          </div>
        )}
        {gates && (
          <ul className="gate-chips" aria-label="Gates">
            <li>≥ {percent(gates.min_accuracy_bp)} accuracy</li>
            <li>≤ {microDollars(gates.max_cost_per_ticket_uusd)} / ticket</li>
            <li>p95 ≤ {seconds(gates.max_p95_latency_ms)}</li>
            <li>No leaks</li>
          </ul>
        )}
        <div className="challenge-card-foot">
          {view?.award && winner ? (
            <span className="win-line">
              <span className="accent">Won</span> at {percent(winner.accuracy_bp)}, {microDollars(winner.cost_per_ticket_uusd)}
              {cut !== null && cut > 0 && <span className="badge badge-green">{cut}% cheaper than baseline</span>}
            </span>
          ) : (
            <span className="muted">{status === "open" ? "Taking sealed submissions" : status === "draft" ? "Sponsor is preparing it" : "No winner"}</span>
          )}
          <ArrowRight className="card-arrow" />
        </div>
      </Link>
    </motion.article>
  );
}

interface Scale {
  label: string;
  unit: (v: number) => string;
  better: "higher" | "lower";
  baseline: number;
  gate: number;
  best: number | null;
  bestLabel: string;
}

/** Where the baseline, the gate and the best result sit on one metric. */
function Track({ scale, delay, seen }: { scale: Scale; delay: number; seen: boolean }) {
  const reduced = usePrefersReducedMotion();
  const values = [scale.baseline, scale.gate, scale.best ?? scale.gate].filter((v) => v > 0);
  const max = Math.max(...values) * 1.12;
  const min = scale.better === "higher" ? Math.min(...values) * 0.9 : 0;
  const at = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  const passes = scale.best !== null && (scale.better === "higher" ? scale.best >= scale.gate : scale.best <= scale.gate);
  const run = seen || reduced;
  const ease = [0.22, 1, 0.36, 1] as const;
  return (
    <div className="track">
      <div className="track-head">
        <span>{scale.label}</span>
        <span className="muted small">{scale.better === "higher" ? "higher is better →" : "← lower is better"}</span>
      </div>
      <div className="track-bar" role="img" aria-label={`${scale.label}: baseline ${scale.unit(scale.baseline)}, gate ${scale.unit(scale.gate)}${scale.best !== null ? `, ${scale.bestLabel.toLowerCase()} ${scale.unit(scale.best)}` : ""}`}>
        <div className={`track-zone ${scale.better}`} style={scale.better === "higher" ? { left: at(scale.gate), right: 0 } : { left: 0, width: at(scale.gate) }} />
        <motion.div className="track-gate" style={{ left: at(scale.gate) }} initial={false} animate={{ scaleY: run ? 1 : 0 }} transition={{ delay, duration: 0.5 }} title={`Gate ${scale.unit(scale.gate)}`} />
        <motion.div className="track-mark baseline" style={{ left: at(scale.baseline) }} initial={false} animate={{ opacity: run ? 1 : 0 }} transition={{ delay: delay + 0.15 }} title={`Baseline ${scale.unit(scale.baseline)}`} />
        {scale.best !== null && (
          <motion.div
            className={`track-mark best ${passes ? "pass" : "fail"}`}
            initial={false}
            animate={{ left: run ? at(scale.best) : at(scale.baseline), opacity: run ? 1 : 0 }}
            transition={{ delay: delay + 0.35, duration: reduced ? 0 : 1.1, ease }}
            title={`${scale.bestLabel} ${scale.unit(scale.best)}`}
          />
        )}
      </div>
      <div className="track-values">
        <span><i className="legend-baseline" /> Baseline <b>{scale.unit(scale.baseline)}</b></span>
        <span><i className="legend-gate" /> Gate <b>{scale.better === "higher" ? "≥" : "≤"} {scale.unit(scale.gate)}</b></span>
        {scale.best !== null && <span className={passes ? "accent" : "coral"}><i className="legend-best" /> {scale.bestLabel} <b>{scale.unit(scale.best)}</b></span>}
      </div>
    </div>
  );
}

/** The bar to clear, shown against the sponsor's baseline and the best result. */
export function TheBar({ gates, baseline, best, bestLabel }: { gates: Gates; baseline: Baseline; best: Metrics | null; bestLabel: string }) {
  const [ref, seen] = useInView<HTMLDivElement>("0px");
  const scales: Scale[] = [
    { label: "Accuracy", unit: percent, better: "higher", baseline: baseline.accuracy_bp, gate: gates.min_accuracy_bp, best: best?.accuracy_bp ?? null, bestLabel },
    { label: "Cost per ticket", unit: microDollars, better: "lower", baseline: baseline.cost_per_ticket_uusd, gate: gates.max_cost_per_ticket_uusd, best: best?.cost_per_ticket_uusd ?? null, bestLabel },
    { label: "p95 latency", unit: seconds, better: "lower", baseline: baseline.p95_latency_ms, gate: gates.max_p95_latency_ms, best: best?.p95_latency_ms ?? null, bestLabel },
  ];
  return (
    <div className="the-bar" ref={ref}>
      {scales.filter((s) => s.baseline > 0).map((scale, i) => <Track key={scale.label} scale={scale} delay={i * 0.12} seen={seen} />)}
      <p className="small muted leak-note">And no card numbers in any reply: one leak fails the challenge.</p>
    </div>
  );
}

export function VerdictTable({ evaluations, network, awarded, highlight }: { evaluations: EvaluationView[]; network: Network; awarded: number | null; highlight: Set<number> }) {
  if (evaluations.length === 0) {
    return <div className="empty"><p>No submissions yet.</p><p className="muted small">The first candidate to clear every gate wins the bounty.</p></div>;
  }
  return (
    <div className="table-wrap">
      <table className="table verdicts">
        <thead>
          <tr>
            <th>#</th><th>Submitter</th><th>Verdict</th>
            <th className="num">Accuracy</th><th className="num">Cost / ticket</th><th className="num">p95</th><th className="num">Leaks</th><th>Config</th><th>Settled</th>
          </tr>
        </thead>
        <tbody>
          {[...evaluations].reverse().map((e) => {
            const m = verdictMetrics(e);
            const won = e.id === awarded;
            return (
              <tr key={e.id} id={`evaluation-${e.id}`} className={`${highlight.has(e.id) ? "highlight" : ""} ${won ? "winner" : ""}`}>
                <td className="mono muted">{e.id}</td>
                <td>
                  <Account id={e.submitter} network={network} />
                  {e.eligible === false && <span className="badge trial">Trial</span>}
                </td>
                <td>
                  {e.status === "Passed" ? (
                    <span className={`badge badge-dot ${won ? "badge-sky" : "badge-green"}`}>{won ? "Won the bounty" : "Passed"}</span>
                  ) : e.status === "Pending" ? (
                    <span className="badge badge-dot badge-amber badge-live">Scoring</span>
                  ) : (
                    <span className="verdict-fail"><span className="badge badge-dot badge-coral">{e.status}</span> <span className="small text-2">{e.reasons.map(reasonText).join(", ")}</span></span>
                  )}
                </td>
                <td className="num">{percent(m?.accuracy_bp)}</td>
                <td className="num">{microDollars(m?.cost_per_ticket_uusd)}</td>
                <td className="num">{seconds(m?.p95_latency_ms)}</td>
                <td className="num">{m?.leaks ?? "–"}</td>
                <td className="mono small" title={e.config_sha256}>{shortHash(e.config_sha256)}</td>
                <td className="small muted">{utc(nsToDate(e.settled_at))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
