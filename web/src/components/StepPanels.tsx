/**
 * The four steps of a bake-off, each with a panel showing the latest winning
 * challenge at that step. The landing page's spotlight shows them one at a
 * time.
 */

import type { ReactNode } from "react";
import type { ChallengeSummary } from "../lib/data.ts";
import { microDollars, percent, seconds, shortHash } from "../lib/format.ts";
import { challengeGates, formatNear } from "../lib/near.ts";
import { Bot, Building, Check, Coins, Lock } from "./Icons.tsx";

export const STEPS = [
  { icon: Building, title: "Set the goal", text: "A team publishes its workflow's baseline, commits to hidden test cases by hash, sets requirements for quality, cost, speed and leaks, and puts up a reward." },
  { icon: Bot, title: "Compete in the open", text: "Builders and their agents tune solutions on public practice cases, scored by the exact evaluator the challenge pins." },
  { icon: Lock, title: "Test on hidden cases", text: "Each submission runs once inside an OutLayer enclave against the hidden cases. Only totals and hashes come out." },
  { icon: Coins, title: "Reward the result", text: "The contract checks every hash against its commitments, records the result, and pays the earliest-submitted solution that meets every requirement." },
];

export type Props = { win: ChallengeSummary | null };

function Panel({ title, tag, children }: { title: ReactNode; tag?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-head"><span>{title}</span>{tag}</div>
      {children}
    </div>
  );
}

export function GoalPanel({ win }: Props) {
  const gates = win?.view ? challengeGates(win.view) : null;
  const base = win?.listing.baseline;
  const reward = win?.view?.award?.amount ?? win?.view?.bounty;
  const rows = [
    ["Accuracy", percent(base?.accuracy_bp), gates ? `≥ ${percent(gates.min_accuracy_bp)}` : "–"],
    ["Cost per ticket", microDollars(base?.cost_per_ticket_uusd), gates ? `≤ ${microDollars(gates.max_cost_per_ticket_uusd)}` : "–"],
    ["p95 latency", seconds(base?.p95_latency_ms), gates ? `≤ ${seconds(gates.max_p95_latency_ms)}` : "–"],
    ["Card numbers repeated", "–", gates ? (gates.max_leaks === 0 ? "None" : `≤ ${gates.max_leaks}`) : "–"],
  ];
  return (
    <Panel title={win ? `${win.listing.sponsor} · ${win.listing.title}` : "A challenge"} tag={<span className="badge">Goal</span>}>
      <div className="panel-table">
        <div className="panel-row panel-row-head"><span /><span>Today</span><span>Needed</span></div>
        {rows.map(([label, today, needed], i) => (
          <div key={label} className="panel-row" style={{ "--i": i } as React.CSSProperties}>
            <span>{label}</span><span className="mono muted">{today}</span><span className="mono">{needed}</span>
          </div>
        ))}
      </div>
      <div className="panel-facts">
        <div style={{ "--i": 4 } as React.CSSProperties}><Lock /><span>Hidden test set</span><span className="mono">{win?.view ? shortHash(win.view.test_set_sha256) : "–"}</span></div>
        <div style={{ "--i": 5 } as React.CSSProperties}><Coins /><span>Reward held by the contract</span><span className="mono amber">{reward ? formatNear(reward) : "–"}</span></div>
      </div>
    </Panel>
  );
}

export function CompetePanel({ win }: Props) {
  const lines = [
    ["get_challenge", "rules, requirements and commitments"],
    ["get_practice_tickets", `${win?.listing.practice_tickets ?? "the"} public practice tickets`],
    ["score_on_practice", `evaluator ${win?.view ? shortHash(win.view.evaluator.sha256) : "build"}, checked against its hash`],
    [null, "edits the prompt, scores again"],
    ["submit_candidate", "asks you, then submits for the sealed run"],
  ] as const;
  return (
    <Panel title="Your agent, through the Bakeoff MCP server" tag={<span className="badge">Practice</span>}>
      <div className="term" role="presentation">
        {lines.map(([tool, note], i) => (
          <div key={i} className={`term-line ${tool ? "" : "term-comment"}`} style={{ "--i": i } as React.CSSProperties}>
            {tool ? <><span className="term-prompt">›</span><span className="term-tool">{tool}</span></> : <span className="term-prompt">#</span>}
            <span className="term-note">{note}</span>
          </div>
        ))}
        <span className="term-cursor" />
      </div>
    </Panel>
  );
}

export function SealedPanel({ win }: Props) {
  const m = win?.winner;
  const tickets = m?.tickets ?? win?.listing.tickets ?? 100;
  const out = [
    ["accuracy", percent(m?.accuracy_bp)],
    ["cost per ticket", microDollars(m?.cost_per_ticket_uusd)],
    ["p95 latency", seconds(m?.p95_latency_ms)],
    ["leaks", m?.leaks !== undefined ? String(m.leaks) : "–"],
  ];
  return (
    <Panel title="One sealed run" tag={<span className="badge">OutLayer TEE</span>}>
      <div className="enclave">
        <div className="enclave-box">
          <span className="enclave-label"><Lock /> Enclave</span>
          <div className="enclave-grid" aria-hidden="true">
            {Array.from({ length: tickets }, (_, i) => <span key={i} style={{ "--d": `${(i * 37) % 23}` } as React.CSSProperties} />)}
          </div>
          <span className="enclave-note">{tickets} hidden tickets and the model key, decrypted only here</span>
        </div>
        <div className="enclave-flow" aria-hidden="true"><span /></div>
        <div className="enclave-out">
          <span className="enclave-label">Only this comes out</span>
          {out.map(([k, v], i) => (
            <div key={k} className="panel-row two" style={{ "--i": i } as React.CSSProperties}><span>{k}</span><span className="mono">{v}</span></div>
          ))}
          <div className="panel-row panel-note" style={{ "--i": 4 } as React.CSSProperties}>+ the hashes of the rules, solution and test set</div>
        </div>
      </div>
    </Panel>
  );
}

export function RewardPanel({ win }: Props) {
  const award = win?.view?.award;
  const checks = ["The rules hash matches its commitment", "The test set hash matches its commitment", "Scored by the pinned evaluator build", "Every requirement is met"];
  return (
    <Panel title={award ? `Result #${award.evaluation}` : "The result"} tag={<span className="badge badge-green badge-dot">Passed</span>}>
      <ul className="panel-checks">
        {checks.map((c, i) => <li key={c} style={{ "--i": i } as React.CSSProperties}><span className="panel-check"><Check /></span>{c}</li>)}
      </ul>
      <div className="panel-pay" style={{ "--i": 4 } as React.CSSProperties}>
        <Coins />
        <span>Paid <strong className="amber">{award ? formatNear(award.amount) : "the reward"}</strong> to <span className="mono">{award?.winner ?? "the winner"}</span>, in the same transaction</span>
      </div>
    </Panel>
  );
}
