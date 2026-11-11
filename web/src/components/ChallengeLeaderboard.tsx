/** A challenge's leaderboard: each builder once by their best result, or every result as recorded. */

import { motion } from "motion/react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ChallengeDetail } from "../lib/data.ts";
import { ago, microDollars, percent, seconds } from "../lib/format.ts";
import { usePrefersReducedMotion } from "../lib/hooks.ts";
import { type Entry, rankBuilders } from "../lib/leaderboard.ts";
import { challengeGates } from "../lib/near.ts";
import { Avatar } from "./art.tsx";
import { Medal, STANDING } from "./board.tsx";
import { reasonText, ResultsTable } from "./challenge.tsx";
import { ArrowRight, Search } from "./Icons.tsx";

function Podium({ entries, challenge }: { entries: Entry[]; challenge: string }) {
  const reduced = usePrefersReducedMotion();
  const top = entries.filter((e) => e.rank !== null && e.rank <= 3);
  if (top.length === 0) return null;
  return (
    <div className="podium">
      {top.map((e, i) => (
        <motion.div key={e.account} initial={reduced ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
          <Link to={`/challenges/${challenge}/results/${e.best.id}`} className={`podium-card card place-${e.rank}`}>
            <div className="podium-top"><Medal rank={e.rank} /><span className={`chip ${STANDING[e.standing].tone}`}>{STANDING[e.standing].label}</span></div>
            <div className="podium-who"><Avatar id={e.account} size={36} /><strong className="break">{e.account}</strong></div>
            <dl className="podium-stats">
              <div><dt>Accuracy</dt><dd>{percent(e.metrics?.accuracy_bp)}</dd></div>
              <div><dt>Cost</dt><dd>{microDollars(e.metrics?.cost_per_ticket_uusd)}</dd></div>
              <div><dt>p95</dt><dd>{seconds(e.metrics?.p95_latency_ms)}</dd></div>
            </dl>
          </Link>
        </motion.div>
      ))}
    </div>
  );
}

function BuildersTable({ entries, challenge }: { entries: Entry[]; challenge: string }) {
  const navigate = useNavigate();
  if (entries.length === 0) return <div className="empty"><p>No results yet.</p><p className="muted small">The earliest-submitted solution to meet every requirement wins the reward.</p></div>;
  return (
    <div className="table-wrap">
      <table className="table board-table">
        <thead>
          <tr>
            <th>#</th><th>Builder</th><th>Best result</th>
            <th className="num">Accuracy</th><th className="num">Cost / ticket</th><th className="num">p95</th><th className="num">Leaks</th><th className="num">Met</th><th className="num">Entries</th><th>Last</th><th><span className="sr-only">Result</span></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const href = `/challenges/${challenge}/results/${e.best.id}`;
            return (
              <tr key={e.account} className={`result-row ${e.standing === "winner" ? "winner" : ""} ${e.trial ? "trial-row" : ""}`} onClick={(event) => {
                if (!(event.target as HTMLElement).closest("a, button")) navigate(href);
              }}>
                <td><Medal rank={e.rank} /></td>
                <td>
                  <Link to={`/accounts/${e.account}`} className="who"><Avatar id={e.account} size={26} /><span>{e.account}</span></Link>
                  {e.trial && <span className="badge trial">Owner's trial</span>}
                </td>
                <td>
                  <span className={`chip ${STANDING[e.standing].tone}`}>{STANDING[e.standing].label}</span>
                  {(e.standing === "failed" || e.standing === "rejected") && e.best.reasons.length > 0 && <span className="small text-2 reason-note">{e.best.reasons.map(reasonText).join(", ")}</span>}
                </td>
                <td className="num">{percent(e.metrics?.accuracy_bp)}</td>
                <td className="num">{microDollars(e.metrics?.cost_per_ticket_uusd)}</td>
                <td className="num">{seconds(e.metrics?.p95_latency_ms)}</td>
                <td className="num">{e.metrics?.leaks ?? "–"}</td>
                <td className="num"><span className={`met-dots met-${e.met}`} aria-label={`${e.met} of 4 requirements met`}>{e.met}/4</span></td>
                <td className="num">{e.entries}</td>
                <td className="small muted">{ago(e.last)}</td>
                <td><Link to={href} className="row-link">#{e.best.id} <ArrowRight /></Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ChallengeLeaderboard({ detail, highlight, children }: { detail: ChallengeDetail; highlight: Set<number>; children?: React.ReactNode }) {
  const [view, setView] = useState<"builders" | "results">("builders");
  const [query, setQuery] = useState("");
  const id = detail.listing.id;
  const award = detail.view.award;
  const entries = rankBuilders(detail.evaluations, challengeGates(detail.view), award?.evaluation ?? null);
  const q = query.trim().toLowerCase();
  const filtered = q ? entries.filter((e) => e.account.includes(q)) : entries;
  return (
    <div className="leaderboard">
      <div className="lb-bar">
        <div className="explorer-search">
          <Search className="search-icon" />
          <input className="search-input" type="search" placeholder="Search builders" aria-label="Search the leaderboard" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="segmented" role="radiogroup" aria-label="Leaderboard view">
          {(["builders", "results"] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {view === v && <motion.span layoutId="lb-pill" className="segmented-pill" transition={{ type: "spring", bounce: 0.2, duration: 0.4 }} />}
              <span>{v === "builders" ? "Builders" : "All results"}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="muted small lb-note">
        {view === "builders"
          ? <>Ranked on the {detail.listing.tickets || ""} hidden tickets. Each builder appears once, with their best result. The earliest submission to meet every requirement wins the reward; the owner's trial runs are listed but never ranked.</>
          : <>Every submission, newest first, as the contract recorded it.</>}
      </p>
      {view === "builders" ? (
        <>
          {!q && <Podium entries={entries} challenge={id} />}
          <div className="card card-pad"><BuildersTable entries={filtered} challenge={id} /></div>
        </>
      ) : (
        <div className="card card-pad">
          <ResultsTable challenge={id} evaluations={q ? detail.evaluations.filter((e) => e.submitter.includes(q)) : detail.evaluations} network={detail.network} awarded={award?.evaluation ?? null} highlight={highlight} />
          {children}
        </div>
      )}
    </div>
  );
}
