/**
 * A challenge's data, as a competition page shows it: what builders can see
 * against what stays sealed, a dictionary of the fields, how the practice
 * labels are spread, and the practice tickets themselves.
 */

import { useMemo, useState } from "react";
import type { ChallengeDetail } from "../lib/data.ts";
import { useAsync } from "../lib/hooks.ts";
import { CopyButton } from "./ui.tsx";
import { Book, Database, Download, Lock, Search } from "./Icons.tsx";

interface Ticket { id: string; text: string; label: { category: string; priority: string } }

const PAGE = 10;

/** The rules' label sets, which the contract stores, in their own order. */
function labelSets(rulesJson: string): { categories: string[]; priorities: string[] } {
  try {
    const rules = JSON.parse(rulesJson) as { categories?: string[]; priorities?: string[] };
    return { categories: rules.categories ?? [], priorities: rules.priorities ?? [] };
  } catch {
    return { categories: [], priorities: [] };
  }
}

function Distribution({ title, values, counts, total, active, onPick }: { title: string; values: string[]; counts: Record<string, number>; total: number; active: string | null; onPick: (v: string | null) => void }) {
  const max = Math.max(1, ...values.map((v) => counts[v] ?? 0));
  return (
    <div className="dist card card-pad">
      <div className="dist-head"><h4>{title}</h4><span className="muted small">{values.length} values</span></div>
      <ul>
        {values.map((v) => {
          const n = counts[v] ?? 0;
          return (
            <li key={v}>
              <button type="button" className={`dist-row ${active === v ? "active" : ""}`} onClick={() => onPick(active === v ? null : v)} aria-pressed={active === v}>
                <span className="dist-label mono">{v}</span>
                <span className="dist-bar"><span style={{ width: `${(n / max) * 100}%` }} /></span>
                <span className="dist-n mono">{n}</span>
                <span className="dist-pct muted mono">{total ? Math.round((n / total) * 100) : 0}%</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DataExplorer({ detail }: { detail: ChallengeDetail }) {
  const { listing, view } = detail;
  const source = listing.practice_set;
  const tickets = useAsync<Ticket[] | null>(
    () => (source ? fetch(`./${source}`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<Ticket[]>;
    }) : Promise.resolve(null)),
    `practice:${source ?? ""}`,
  );
  const { categories, priorities } = labelSets(view.rules_json);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [priority, setPriority] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const all = tickets.data ?? [];
  const count = (key: "category" | "priority") => all.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.label[key]]: (acc[t.label[key]] ?? 0) + 1 }), {});
  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () => all.filter((t) => (!category || t.label.category === category) && (!priority || t.label.priority === priority) && (!q || `${t.id} ${t.text}`.toLowerCase().includes(q))),
    [all, category, priority, q],
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(0);
  };

  return (
    <div className="data-tab">
      <section className="doc-section">
        <h2>Dataset description</h2>
        <div className="data-sets">
          <div className="card card-pad data-set">
            <span className="pillar-icon"><Database /></span>
            <h3>Practice set <span className="chip chip-green">Public</span></h3>
            <p className="text-2">{listing.practice_tickets ?? (all.length || "The")} tickets with their labels. Builders tune on them, and the MCP server scores ideas against them with the challenge's own evaluator build.</p>
            {source && <a className="btn btn-sm" href={`./${source}`} download><Download /> practice.json</a>}
          </div>
          <div className="card card-pad data-set">
            <span className="pillar-icon"><Lock /></span>
            <h3>Hidden test set <span className="chip chip-grey">Sealed</span></h3>
            <p className="text-2">{listing.tickets || "The"} tickets labelled by the same guide. They are decrypted only inside OutLayer's enclave, for runs that come through the contract. Only their hash is public:</p>
            <div className="hash-line"><code className="mono break">{view.test_set_sha256}</code><CopyButton text={view.test_set_sha256} label="Copy the test set's hash" /></div>
          </div>
        </div>
      </section>

      <section className="doc-section">
        <h2>Data dictionary</h2>
        <div className="card card-pad">
          <div className="table-wrap">
            <table className="table dict">
              <thead><tr><th>Field</th><th>Meaning</th><th>Values</th></tr></thead>
              <tbody>
                <tr><td className="mono">id</td><td className="wrap">The ticket's identifier</td><td className="mono muted">p01 … p{String(all.length || 80).padStart(2, "0")}</td></tr>
                <tr><td className="mono">text</td><td className="wrap">The customer's message, as the support inbox received it</td><td className="muted">Free text</td></tr>
                <tr><td className="mono">label.category</td><td className="wrap">Which team has to act</td><td className="mono wrap">{categories.join(", ") || "–"}</td></tr>
                <tr><td className="mono">label.priority</td><td className="wrap">How quickly they have to act</td><td className="mono wrap">{priorities.join(", ") || "–"}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="muted small dict-note">
            The categories and priorities are the ones the contract's rules store. A solution answers each ticket with one category, one priority and a short summary, and is scored on both labels.
            {listing.labeling_guide && <> <a className="link-accent" href={`./${listing.labeling_guide}`} target="_blank" rel="noopener noreferrer"><Book /> Read the labeling guide</a></>}
          </p>
        </div>
      </section>

      {source && (
        <section className="doc-section">
          <h2>Practice tickets</h2>
          {tickets.error && <p className="coral">Could not load the practice tickets: {tickets.error.message}</p>}
          <div className="dists">
            <Distribution title="Category" values={categories} counts={count("category")} total={all.length} active={category} onPick={filter(setCategory)} />
            <Distribution title="Priority" values={priorities} counts={count("priority")} total={all.length} active={priority} onPick={filter(setPriority)} />
          </div>
          <div className="card card-pad explorer">
            <div className="explorer-bar">
              <div className="explorer-search">
                <Search className="search-icon" />
                <input className="search-input" type="search" placeholder="Search the tickets" aria-label="Search the practice tickets" value={query} onChange={(e) => filter(setQuery)(e.target.value)} />
              </div>
              <span className="muted small">
                {tickets.data ? `${rows.length} of ${all.length} tickets` : "Loading…"}
                {(category || priority) && <> · <button type="button" className="link-button" onClick={() => { setCategory(null); setPriority(null); setPage(0); }}>clear filters</button></>}
              </span>
            </div>
            <div className="table-wrap">
              <table className="table tickets">
                <thead><tr><th>id</th><th>text</th><th>category</th><th>priority</th></tr></thead>
                <tbody>
                  {shown.map((t) => (
                    <tr key={t.id}>
                      <td className="mono muted">{t.id}</td>
                      <td className="wrap ticket-text">{t.text}</td>
                      <td><span className="chip chip-grey mono">{t.label.category}</span></td>
                      <td><span className={`chip mono ${t.label.priority === "urgent" ? "chip-coral" : t.label.priority === "high" ? "chip-amber" : "chip-grey"}`}>{t.label.priority}</span></td>
                    </tr>
                  ))}
                  {tickets.data && shown.length === 0 && <tr><td colSpan={4} className="muted">No ticket matches.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <span className="muted small mono">{page + 1} / {pages}</span>
              <button type="button" className="btn btn-sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
