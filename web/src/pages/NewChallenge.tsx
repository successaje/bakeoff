/**
 * Setting up a challenge, in the browser. The host describes the task, picks
 * what builders may use and sets the bar from their own baseline; the page
 * writes the rules file, the board listing and the commands to run, filled
 * in. It never asks for the hidden test cases or the model API key, and
 * sends nothing anywhere: the draft stays in this browser, and the scripts
 * read the secrets on the host's own machine.
 */

import { motion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { CodeBlock, CopyButton, Reveal } from "../components/ui.tsx";
import { ArrowRight, Check, Download, Lock, Plus, Shield } from "../components/Icons.tsx";
import { microDollars, percent, seconds } from "../lib/format.ts";
import type { Gates, Network } from "../lib/near.ts";
import { useSession } from "../lib/session.tsx";
import {
  baselineFromReport, baselineOf, challengeId, commandsOf, type Draft, emptyDraft, gatesOf, type Goal, issuesOf,
  json, LIMITS, listingOf, lockCommand, num, REQUEST_OPTIONS, rulesOf, suffix, TEST_SET_PATH,
} from "../lib/setup.ts";

const KEY = "bakeoff:new-challenge";

/** The saved draft, if this browser has one. Storage can be missing or blocked, so a failure is just a fresh start. */
function savedDraft(): Partial<Draft> | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<Draft>) : null;
  } catch {
    return null;
  }
}

const SECTIONS = [
  { id: "challenge", title: "The challenge" },
  { id: "task", title: "The task" },
  { id: "models", title: "Models and limits" },
  { id: "goal", title: "Goal and the bar" },
  { id: "reward", title: "Reward and deadline" },
] as const;

const GOALS: { id: Goal; title: string; text: string }[] = [
  { id: "cheaper", title: "Cheaper", text: "Lower cost a ticket. Accuracy within 2 points, p95 no slower." },
  { id: "faster", title: "Faster", text: "Lower p95. Accuracy within 2 points, cost no higher." },
  { id: "accurate", title: "More accurate", text: "Higher accuracy. Cost and p95 no worse." },
  { id: "custom", title: "Custom", text: "Set each requirement yourself." },
];

function scrollToSection(id: string) {
  document.getElementById(`setup-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A labelled input. Controls that are not one input, like a row of buttons, use a plain container, since a label would press the first button. */
function Field({ label, hint, children, wide = false, group = false }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean; group?: boolean }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className={`field setup-field${wide ? " wide" : ""}`}>
      <span className="setup-label">{label}</span>
      {children}
      {hint && <span className="setup-hint">{hint}</span>}
    </Tag>
  );
}

function Unit({ unit, children }: { unit: string; children: ReactNode }) {
  return <span className="setup-unit">{children}<span>{unit}</span></span>;
}

function Section({ index, id, title, lede, children }: { index: number; id: string; title: string; lede?: string; children: ReactNode }) {
  return (
    <Reveal as="section" className="setup-section card card-pad">
      <div id={`setup-${id}`} className="setup-anchor" />
      <div className="guide-head"><span className="step-num mono">{String(index + 1).padStart(2, "0")}</span><h2>{title}</h2></div>
      {lede && <p className="text-2 setup-lede">{lede}</p>}
      {children}
    </Reveal>
  );
}

/** The bar as one line, like the ridge's label on the home page. */
function barLine(gates: Gates | null): string {
  if (!gates) return "the bar · set your baseline first";
  return `the bar · ≥ ${percent(gates.min_accuracy_bp)} · ≤ ${microDollars(gates.max_cost_per_ticket_uusd)} · ≤ ${seconds(gates.max_p95_latency_ms)} · no card numbers`;
}

type Tab = "commands" | "rules" | "listing";

export function NewChallenge() {
  const session = useSession();
  // A new draft starts on testnet, where a host can run a whole round before spending real NEAR.
  const [draft, setDraft] = useState<Draft>(() => ({ ...emptyDraft("testnet", session.account), ...savedDraft() }));
  const [tab, setTab] = useState<Tab>("commands");
  const [report, setReport] = useState("");
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* the draft just isn't kept */ }
  }, [draft]);
  // A wallet that connects after the page loads fills an empty owner field.
  useEffect(() => {
    if (session.account && !draft.account && session.account.endsWith(suffix(draft.network))) setDraft((d) => ({ ...d, account: session.account ?? "" }));
  }, [session.account, draft.account, draft.network]);

  const up = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const issues = useMemo(() => issuesOf(draft), [draft]);
  const gates = useMemo(() => gatesOf(draft), [draft]);
  const base = baselineOf(draft);
  const id = challengeId(draft);
  const ready = issues.length === 0;
  const files = {
    commands: { name: "setup.sh", type: "text/x-shellscript", text: commandsOf(draft) },
    rules: { name: "rules.json", type: "application/json", text: json(rulesOf(draft)) },
    listing: { name: "listing.json", type: "application/json", text: json(listingOf(draft)) },
  };
  const file = files[tab];
  const hours = (num(draft.days) ?? 0) * 24;

  const readReport = (text: string) => {
    setReport(text);
    if (!text.trim()) return setReportError(null);
    const baseline = baselineFromReport(text);
    if (!baseline) return setReportError("That isn't calibration's report.json: it has no baseline_metrics.");
    setReportError(null);
    up({ baseline });
  };

  return (
    <div className="page">
      <div className="page-hero grid-bg-wrap">
        <div className="grid-bg page-grid" aria-hidden="true" />
        <div className="container">
          <Reveal immediate>
            <span className="eyebrow">Host a challenge</span>
            <h1 className="page-title">Set up a <span className="serif">challenge</span>.</h1>
            <p className="page-lede">Describe the task, choose what builders may use and set the bar from your own baseline. The form writes your rules file, the board listing and every command, with your values filled in.</p>
          </Reveal>
        </div>
      </div>

      <div className="container page-body">
        <Reveal className="setup-safe">
          <span className="feature-icon"><Shield /></span>
          <div>
            <h3>Your test cases and API key never touch this page.</h3>
            <p className="text-2 small">The form runs in your browser and sends nothing; your draft is kept in this browser only. You run the commands on your own machine, where the scripts read both and the OutLayer CLI encrypts them for the evaluator. <Link to="/teams">How hosting works</Link></p>
          </div>
        </Reveal>

        <div className="setup">
          <div className="setup-form">
            <Section index={0} id="challenge" title="The challenge" lede="Who sets the goal, and how the board will show it.">
              <div className="setup-grid">
                <Field label="Network" group wide>
                  <div className="segmented" role="radiogroup" aria-label="Network">
                    {(["testnet", "mainnet"] as Network[]).map((n) => (
                      <button key={n} type="button" role="radio" aria-checked={n === draft.network} className={n === draft.network ? "active" : ""} onClick={() => up({ network: n, account: draft.account.endsWith(suffix(n)) ? draft.account : session.account?.endsWith(suffix(n)) ? session.account : "" })}>
                        {n === draft.network && <motion.span layoutId="setup-network-pill" className="segmented-pill" transition={{ type: "spring", bounce: 0.2, duration: 0.45 }} />}
                        <span>{n === "testnet" ? "Testnet" : "Mainnet"}</span>
                      </button>
                    ))}
                  </div>
                </Field>
                {draft.network === "mainnet" && <p className="setup-warn small"><span className="chip chip-amber">Mainnet</span> Spends real NEAR. The scripts ask you to name your account twice before they do.</p>}
                <Field label="Owner's NEAR account" hint="It signs the deployment and controls funding, opening and withdrawing.">
                  <input className="input" value={draft.account} onChange={(e) => up({ account: e.target.value.trim().toLowerCase() })} placeholder={`you${suffix(draft.network)}`} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="Challenge name" hint={<>Its account will be <span className="mono">{draft.account ? id : `${draft.name}.you${suffix(draft.network)}`}</span></>}>
                  <input className="input" value={draft.name} onChange={(e) => up({ name: e.target.value.trim().toLowerCase() })} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="Title" wide>
                  <input className="input" value={draft.title} onChange={(e) => up({ title: e.target.value })} placeholder="Support ticket triage under 40 µ$" />
                </Field>
                <Field label="Team or company" hint="Shown as the sponsor.">
                  <input className="input" value={draft.sponsor} onChange={(e) => up({ sponsor: e.target.value })} placeholder="Kettle & Kiln" />
                </Field>
                <Field label="Tags" hint="Comma-separated.">
                  <input className="input" value={draft.tags} onChange={(e) => up({ tags: e.target.value })} />
                </Field>
                <Field label="Summary" wide hint="One paragraph: what a winning solution does.">
                  <textarea className="textarea setup-text" rows={3} value={draft.summary} onChange={(e) => up({ summary: e.target.value })} placeholder="Route each support message to the right team and urgency for 40 µ$ a ticket or less, at least 85% accurate, without ever repeating a card number." />
                </Field>
                <Field label="The workflow today (optional)" wide hint="What your current agent does and where it falls short.">
                  <textarea className="textarea setup-text" rows={3} value={draft.problem} onChange={(e) => up({ problem: e.target.value })} />
                </Field>
              </div>
            </Section>

            <Section index={1} id="task" title="The task" lede="Each hidden test case is a real message labelled with one category and one priority. Solutions answer with both, and a one-line summary.">
              <div className="setup-grid">
                <Field label="Categories" wide hint="Comma-separated, exactly as your labels spell them.">
                  <input className="input" value={draft.categories} onChange={(e) => up({ categories: e.target.value })} spellCheck={false} />
                </Field>
                <Field label="Priorities" wide hint="Comma-separated, lowest first.">
                  <input className="input" value={draft.priorities} onChange={(e) => up({ priorities: e.target.value })} spellCheck={false} />
                </Field>
                <Field label="Hidden test cases" hint={<>About 100 works well. Keep the file at <span className="mono">{TEST_SET_PATH}</span>: that folder stays out of git.</>}>
                  <input className="input" inputMode="numeric" value={draft.tickets} onChange={(e) => up({ tickets: e.target.value })} />
                </Field>
              </div>
            </Section>

            <Section index={2} id="models" title="Models and limits" lede="Builders may use only these NEAR AI Cloud models. Cost is worked out from each model's prices per million tokens.">
              <div className="setup-models">
                <div className="setup-model head" aria-hidden="true"><span /><span>Model</span><span>Input $/M</span><span>Output $/M</span><span /></div>
                {draft.models.map((m, i) => {
                  const set = (patch: Partial<typeof m>) => up({ models: draft.models.map((row, j) => (j === i ? { ...row, ...patch } : row)) });
                  return (
                    <div key={i} className={`setup-model${m.on ? "" : " off"}`}>
                      <input type="checkbox" checked={m.on} onChange={(e) => set({ on: e.target.checked })} aria-label={`Allow ${m.id || "this model"}`} />
                      <input className="input mono" value={m.id} onChange={(e) => set({ id: e.target.value.trim() })} placeholder="provider/model" spellCheck={false} aria-label="Model name" />
                      <input className="input" inputMode="decimal" value={m.input} onChange={(e) => set({ input: e.target.value })} aria-label="Input price, USD per million tokens" />
                      <input className="input" inputMode="decimal" value={m.output} onChange={(e) => set({ output: e.target.value })} aria-label="Output price, USD per million tokens" />
                      <button type="button" className="link-button small" onClick={() => up({ models: draft.models.filter((_, j) => j !== i) })} aria-label={`Remove ${m.id || "this model"}`}>Remove</button>
                    </div>
                  );
                })}
                <button type="button" className="btn btn-sm setup-add" onClick={() => up({ models: [...draft.models, { id: "", input: "", output: "", on: true }] })}><Plus /> Add a model</button>
              </div>
              <fieldset className="setup-options">
                <legend className="setup-label">Request options builders may set</legend>
                {REQUEST_OPTIONS.map((o) => (
                  <label key={o} className="setup-check">
                    <input type="checkbox" checked={draft.options.includes(o)} onChange={(e) => up({ options: e.target.checked ? [...draft.options, o] : draft.options.filter((x) => x !== o) })} />
                    <span className="mono small">{o}</span>
                  </label>
                ))}
              </fieldset>
              <details className="setup-more">
                <summary className="small">Run limits</summary>
                <div className="setup-grid">
                  <Field label="Time budget" hint={`For the whole run, at most ${LIMITS.timeBudgetS} s to fit NEAR's wait for a result.`}>
                    <Unit unit="s"><input className="input" inputMode="decimal" value={draft.timeBudget} onChange={(e) => up({ timeBudget: e.target.value })} /></Unit>
                  </Field>
                  <Field label="Calls at once" hint={`1 to ${LIMITS.concurrency}.`}>
                    <input className="input" inputMode="numeric" value={draft.concurrency} onChange={(e) => up({ concurrency: e.target.value })} />
                  </Field>
                  <Field label="Reply length cap" hint="The most max_tokens a solution may ask for.">
                    <Unit unit="tokens"><input className="input" inputMode="numeric" value={draft.maxTokens} onChange={(e) => up({ maxTokens: e.target.value })} /></Unit>
                  </Field>
                  <Field label="Temperature" hint="0 to 2. Leave empty for models that reject it.">
                    <input className="input" inputMode="decimal" value={draft.temperature} onChange={(e) => up({ temperature: e.target.value })} />
                  </Field>
                </div>
              </details>
            </Section>

            <Section index={3} id="goal" title="Goal and the bar" lede="Measure your current agent with calibration first (command 1). It runs three times and takes the median of each metric, because models vary a little between runs.">
              <div className="setup-grid three">
                <Field label="Baseline accuracy">
                  <Unit unit="%"><input className="input" inputMode="decimal" value={draft.baseline.accuracy} onChange={(e) => up({ baseline: { ...draft.baseline, accuracy: e.target.value } })} placeholder="87" /></Unit>
                </Field>
                <Field label="Baseline cost">
                  <Unit unit="µ$/ticket"><input className="input" inputMode="decimal" value={draft.baseline.cost} onChange={(e) => up({ baseline: { ...draft.baseline, cost: e.target.value } })} placeholder="128" /></Unit>
                </Field>
                <Field label="Baseline p95">
                  <Unit unit="s"><input className="input" inputMode="decimal" value={draft.baseline.p95} onChange={(e) => up({ baseline: { ...draft.baseline, p95: e.target.value } })} placeholder="18.2" /></Unit>
                </Field>
              </div>
              <details className="setup-more">
                <summary className="small">Paste calibration's report.json instead</summary>
                <textarea className="textarea" rows={4} value={report} onChange={(e) => readReport(e.target.value)} placeholder='{ "baseline_metrics": { … } }' spellCheck={false} aria-label="report.json" />
                {reportError ? <p className="setup-error small">{reportError}</p> : report.trim() && <p className="setup-ok small"><Check /> Baseline read from the report.</p>}
                <p className="muted small">The report holds only totals, nothing about individual test cases, so it is safe to paste and to publish.</p>
              </details>

              <div className="setup-goals" role="radiogroup" aria-label="Goal">
                {GOALS.map((g) => (
                  <button key={g.id} type="button" role="radio" aria-checked={draft.goal === g.id} className={`setup-goal${draft.goal === g.id ? " active" : ""}`}
                    onClick={() => up(g.id === "custom" && draft.goal !== "custom" && gates
                      ? { goal: g.id, custom: { accuracy: String(gates.min_accuracy_bp / 100), cost: String(gates.max_cost_per_ticket_uusd), p95: String(gates.max_p95_latency_ms / 1000) } }
                      : { goal: g.id })}>
                    <strong>{g.title}</strong>
                    <span className="small text-2">{g.text}</span>
                  </button>
                ))}
              </div>

              <div className="setup-grid three">
                {draft.goal === "cheaper" && (
                  <Field label="Cut the cost by">
                    <Unit unit="%"><input className="input" inputMode="decimal" value={draft.cut} onChange={(e) => up({ cut: e.target.value })} /></Unit>
                  </Field>
                )}
                {draft.goal === "faster" && (
                  <Field label="p95 at most">
                    <Unit unit="s"><input className="input" inputMode="decimal" value={draft.fastP95} onChange={(e) => up({ fastP95: e.target.value })} /></Unit>
                  </Field>
                )}
                {draft.goal === "accurate" && (
                  <Field label="Accuracy at least">
                    <Unit unit="%"><input className="input" inputMode="decimal" value={draft.accuracyTarget} onChange={(e) => up({ accuracyTarget: e.target.value })} /></Unit>
                  </Field>
                )}
                {draft.goal === "custom" && (
                  <>
                    <Field label="Accuracy at least"><Unit unit="%"><input className="input" inputMode="decimal" value={draft.custom.accuracy} onChange={(e) => up({ custom: { ...draft.custom, accuracy: e.target.value } })} /></Unit></Field>
                    <Field label="Cost at most"><Unit unit="µ$/ticket"><input className="input" inputMode="decimal" value={draft.custom.cost} onChange={(e) => up({ custom: { ...draft.custom, cost: e.target.value } })} /></Unit></Field>
                    <Field label="p95 at most"><Unit unit="s"><input className="input" inputMode="decimal" value={draft.custom.p95} onChange={(e) => up({ custom: { ...draft.custom, p95: e.target.value } })} /></Unit></Field>
                  </>
                )}
              </div>

              <div className="setup-bar">
                <p className="mono small">{barLine(gates)}</p>
                {gates && base && (
                  <div className="setup-bar-rows">
                    {[
                      { label: "Accuracy", today: percent(base.accuracy_bp), bar: `≥ ${percent(gates.min_accuracy_bp)}` },
                      { label: "Cost a ticket", today: microDollars(base.cost_per_ticket_uusd), bar: `≤ ${microDollars(gates.max_cost_per_ticket_uusd)}` },
                      { label: "p95 latency", today: seconds(base.p95_latency_ms), bar: `≤ ${seconds(gates.max_p95_latency_ms)}` },
                      { label: "Card numbers repeated", today: "–", bar: "none" },
                    ].map((row) => (
                      <div key={row.label} className="setup-bar-row"><span className="text-2 small">{row.label}</span><span className="mono small muted">today {row.today}</span><span className="mono small">{row.bar}</span></div>
                    ))}
                  </div>
                )}
              </div>
            </Section>

            <Section index={4} id="reward" title="Reward and deadline" lede="You fund and open the challenge from its page once it is deployed. The reward returns to you if nobody meets the bar by the deadline.">
              <div className="setup-grid">
                <Field label="Reward">
                  <Unit unit="NEAR"><input className="input" inputMode="decimal" value={draft.reward} onChange={(e) => up({ reward: e.target.value })} /></Unit>
                </Field>
                <Field label="Open for" hint={hours > 0 ? `${hours} hours on the challenge page.` : undefined}>
                  <Unit unit="days"><input className="input" inputMode="numeric" value={draft.days} onChange={(e) => up({ days: e.target.value })} /></Unit>
                </Field>
              </div>
              <p className="muted small setup-costs">Deploying costs about 2.5 NEAR, mostly storage you get back by deleting the challenge. Storing the test cases takes a deposit of about 0.25 NEAR, and each scoring run about 0.02 NEAR.</p>
            </Section>
          </div>

          <aside className="setup-out">
            <div className="card setup-panel">
              <div className="setup-status">
                {ready
                  ? <><span className="chip chip-green"><Check /> Ready</span><span className="small text-2">Every value checks out. Download the files and run the commands.</span></>
                  : <><span className="chip chip-amber">{issues.length} to finish</span><span className="small text-2">The files update as you type.</span></>}
              </div>
              {!ready && (
                <ul className="setup-issues">
                  {SECTIONS.filter((section) => issues.some((i) => i.section === section.id)).map((section) => (
                    <li key={section.id}>
                      <button type="button" className="link-button small" onClick={() => scrollToSection(section.id)}>{section.title}</button>
                      <ul>{issues.filter((i) => i.section === section.id).map((i) => <li key={i.text} className="small">{i.text}</li>)}</ul>
                    </li>
                  ))}
                </ul>
              )}
              <div className="segmented setup-tabs" role="tablist" aria-label="Output">
                {([["commands", "Commands"], ["rules", "Rules file"], ["listing", "Listing"]] as [Tab, string][]).map(([t, label]) => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                    {tab === t && <motion.span layoutId="setup-tab-pill" className="segmented-pill" transition={{ type: "spring", bounce: 0.2, duration: 0.45 }} />}
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <div className="setup-file">
                <div className="setup-file-head">
                  <span className="mono small">{file.name}</span>
                  <span className="setup-file-actions">
                    <CopyButton text={file.text} />
                    <button type="button" className="btn btn-sm" onClick={() => download(file.name, file.text, file.type)}><Download /> Download</button>
                  </span>
                </div>
                <pre className="code setup-code" aria-label={file.name}>{file.text}</pre>
                {tab === "listing" && <p className="muted small">Add it under <span className="mono">"{draft.network}"</span> in <span className="mono">web/public/challenges.json</span> with a pull request. Until then the challenge opens at its address with its on-chain data.</p>}
                {tab === "rules" && <p className="muted small">Calibration ignores the requirements in this file, so download it once before calibrating and again after you enter the baseline.</p>}
              </div>
              {tab === "commands" && (
                <ol className="setup-next">
                  <li><span className="mono">5</span><div><strong>Fund and open it</strong><p className="small text-2">On <Link to={`/challenges/${id}`}>its page</Link>, connect {draft.account || "the owner's wallet"} and use Manage: fund {num(draft.reward) ?? "the reward in"} NEAR, then open it for {hours || "the number of"} hours.</p></div></li>
                  <li><span className="mono">6</span><div><strong>Lock it</strong><p className="small text-2">Deletes the challenge account's keys, so nobody, you included, can change its code. This cannot be undone.</p><CodeBlock code={lockCommand(draft)} /></div></li>
                  <li><span className="mono">7</span><div><strong>List it on the board</strong><p className="small text-2">Add the listing from the Listing tab to <span className="mono">web/public/challenges.json</span>.</p></div></li>
                </ol>
              )}
            </div>
            <div className="setup-foot">
              <button type="button" className="link-button small" onClick={() => { setDraft(emptyDraft("testnet", session.account)); setReport(""); setReportError(null); }}>Start over</button>
              <Link to="/teams" className="small">How hosting works <ArrowRight /></Link>
              <span className="muted small setup-lock"><Lock /> Nothing leaves this browser</span>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
