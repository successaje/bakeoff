/** Cards and labels shared by the landing page, the challenge list and the leaderboards. */

import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ChallengeDetail, ChallengeSummary } from "../lib/data.ts";
import { ago, microDollars, percent, seconds, toGo } from "../lib/format.ts";
import { type Activity, type Entry, rankBuilders, type Standing } from "../lib/leaderboard.ts";
import { challengeGates, type ChallengeView, formatNear, nsToDate } from "../lib/near.ts";
import { useNow } from "../lib/hooks.ts";
import { Avatar, Cover, HostMark } from "./art.tsx";
import { ArrowRight, Coins, Trophy, Users } from "./Icons.tsx";
import { DemoBadge, displayStatus, type DisplayStatus } from "./ui.tsx";

export function SectionHead({ eyebrow, title, lede, action }: { eyebrow?: string; title: ReactNode; lede?: ReactNode; action?: ReactNode }) {
  return (
    <div className="board-head">
      <div>
        {eyebrow && <span className="mono-label">{eyebrow}</span>}
        <h2>{title}</h2>
        {lede && <p className="text-2">{lede}</p>}
      </div>
      {action}
    </div>
  );
}

const CHIP: Record<DisplayStatus, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "chip-grey" },
  open: { label: "Open", tone: "chip-green" },
  closing: { label: "Deadline passed", tone: "chip-amber" },
  awarded: { label: "Awarded", tone: "chip-violet" },
  closed: { label: "Closed", tone: "chip-grey" },
};

export function StatusChip({ view }: { view: ChallengeView }) {
  const now = useNow(30_000);
  const chip = CHIP[displayStatus(view, now)];
  return <span className={`chip ${chip.tone}`}>{chip.label}</span>;
}

/** What a card's footer says about time: how long is left, or how it ended. */
function timeLine(view: ChallengeView, now: number): string {
  const status = displayStatus(view, now);
  if (status === "open") return toGo(nsToDate(view.closes_at), now) ?? "Closing";
  if (status === "awarded") return view.award?.paid ? "Reward paid" : "Reward won";
  if (status === "draft") return "Not open yet";
  return status === "closing" ? "Deadline passed" : "Closed";
}

/** The share of tickets a cover draws lit: the winner's accuracy once there is one. */
const litFor = (summary: ChallengeSummary) => (summary.winner?.accuracy_bp ? summary.winner.accuracy_bp / 10_000 : 0.35);

/** A wide card for the landing page: cover on the left, the facts on the right. */
export function ChallengeTile({ summary }: { summary: ChallengeSummary }) {
  const { listing, view } = summary;
  const now = useNow(60_000);
  const gates = view ? challengeGates(view) : null;
  return (
    <Link to={`/challenges/${listing.id}`} className="tile card" aria-label={`${listing.title}, ${listing.sponsor}`}>
      <Cover id={listing.id} lit={litFor(summary)} className="tile-cover" />
      <div className="tile-body">
        <div className="tile-host">
          <HostMark name={listing.sponsor} size={26} />
          <span className="tile-sponsor">{listing.sponsor}</span>
          {view && <StatusChip view={view} />}
        </div>
        <h3>{listing.title}</h3>
        <p className="tile-summary">{listing.summary}</p>
        {gates && (
          <ul className="tile-gates" aria-label="Requirements">
            <li>≥ {percent(gates.min_accuracy_bp)}</li>
            <li>≤ {microDollars(gates.max_cost_per_ticket_uusd)}</li>
            <li>≤ {seconds(gates.max_p95_latency_ms)}</li>
            <li>{gates.max_leaks === 0 ? "No leaks" : `≤ ${gates.max_leaks} leaks`}</li>
          </ul>
        )}
        <p className="tile-meta muted">{view ? `${view.evaluations} result${view.evaluations === 1 ? "" : "s"}` : "Unavailable"}{listing.demo && " · Demo round"}</p>
        <div className="tile-foot">
          <span className="tile-reward"><Trophy /> {view ? formatNear(view.award?.amount ?? view.bounty ?? "0") : "–"}</span>
          <span className="muted small">{view ? timeLine(view, now) : ""}</span>
        </div>
      </div>
    </Link>
  );
}

/** A tall card for the challenge list: cover on top, the host's mark over its edge. */
export function ChallengeCard({ summary }: { summary: ChallengeSummary }) {
  const { listing, view, winner, error } = summary;
  const now = useNow(60_000);
  const gates = view ? challengeGates(view) : null;
  return (
    <Link to={`/challenges/${listing.id}`} className="ccard card" aria-label={`${listing.title}, ${listing.sponsor}`}>
      <div className="ccard-art">
        <Cover id={listing.id} lit={litFor(summary)} />
        <span className="ccard-mark"><HostMark name={listing.sponsor} size={40} /></span>
      </div>
      <div className="ccard-body">
        <div className="ccard-kind">
          <span><Trophy /> Challenge</span>
          {listing.demo && <DemoBadge />}
          {view && <StatusChip view={view} />}
        </div>
        <h3>{listing.title}</h3>
        <p className="ccard-summary">{listing.summary}</p>
        {error && <p className="coral small">{error}</p>}
        <p className="muted small">
          {listing.sponsor}
          {gates && <> · ≥ {percent(gates.min_accuracy_bp)}, ≤ {microDollars(gates.max_cost_per_ticket_uusd)} a ticket</>}
        </p>
        {winner && <p className="ccard-win"><span className="chip chip-green">Won</span> {percent(winner.accuracy_bp)} at {microDollars(winner.cost_per_ticket_uusd)}</p>}
      </div>
      <div className="ccard-foot">
        <strong className="ccard-reward"><Coins /> {view ? formatNear(view.award?.amount ?? view.bounty ?? "0") : "–"}</strong>
        <span className="muted small">{view ? `${view.evaluations} results · ${timeLine(view, now)}` : ""}</span>
      </div>
    </Link>
  );
}

const ACTIVITY: Record<Activity["kind"], { label: string; tone: string }> = {
  paid: { label: "Reward paid", tone: "chip-amber" },
  passed: { label: "Passed", tone: "chip-green" },
  failed: { label: "Missed the goal", tone: "chip-coral" },
  scoring: { label: "Scoring", tone: "chip-sky" },
};

/** One thing that happened on-chain, as a small floating card. */
export function ActivityCard({ activity }: { activity: Activity }) {
  const chip = activity.trial ? { label: "Owner's trial", tone: "chip-grey" } : ACTIVITY[activity.kind];
  return (
    <Link to={`/challenges/${activity.challenge}/results/${activity.evaluation}`} className="activity card">
      <div className="activity-top">
        <span className={`chip ${chip.tone}`}>{chip.label}</span>
        <span className="muted mono small">{ago(activity.at)}</span>
      </div>
      <p className="activity-text">
        <Avatar id={activity.account} size={20} />
        <span className="break"><strong>{activity.account}</strong> {activity.kind === "paid" ? <>was paid {formatNear(activity.amount ?? "0")}</> : <>· result #{activity.evaluation}</>}</span>
      </p>
      <p className="muted small activity-title">{activity.title}</p>
    </Link>
  );
}

export function Medal({ rank }: { rank: number | null }) {
  if (rank === null) return <span className="rank muted">–</span>;
  if (rank > 3) return <span className="rank">{rank}</span>;
  return <span className={`medal medal-${rank}`} aria-label={`Rank ${rank}`}>{rank}</span>;
}

export const STANDING: Record<Standing, { label: string; tone: string }> = {
  winner: { label: "Won the reward", tone: "chip-violet" },
  passed: { label: "Met every requirement", tone: "chip-green" },
  scoring: { label: "Scoring", tone: "chip-sky" },
  failed: { label: "Missed", tone: "chip-coral" },
  rejected: { label: "Rejected", tone: "chip-grey" },
};

export function topEntries(detail: ChallengeDetail): Entry[] {
  return rankBuilders(detail.evaluations, challengeGates(detail.view), detail.view.award?.evaluation ?? null);
}

/** A pill linking on, in the section heads' style. */
export function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="btn">{children} <ArrowRight /></Link>;
}

export function Participants({ count }: { count: number }) {
  return <span className="participants"><Users /> {count} builder{count === 1 ? "" : "s"}</span>;
}
