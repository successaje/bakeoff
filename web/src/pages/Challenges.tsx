import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ChallengeCard } from "../components/board.tsx";
import { Flag, Layers, Plus, Search, Shield, Sparkle, Trophy } from "../components/Icons.tsx";
import { displayStatus, Reveal } from "../components/ui.tsx";
import { type ChallengeSummary, loadChallenges } from "../lib/data.ts";
import { useAsync } from "../lib/hooks.ts";
import { useSession } from "../lib/session.tsx";

type Filter = "all" | "open" | "awarded" | "draft" | "demo";

const FILTERS: { id: Filter; label: string; text: string; icon: typeof Trophy; test: (row: ChallengeSummary) => boolean }[] = [
  { id: "all", label: "All challenges", text: "Everything, past and present", icon: Layers, test: () => true },
  { id: "open", label: "Open now", text: "Taking submissions", icon: Sparkle, test: (r) => !!r.view && displayStatus(r.view) === "open" },
  { id: "awarded", label: "Awarded", text: "Won, with the winning config", icon: Trophy, test: (r) => !!r.view && displayStatus(r.view) === "awarded" },
  { id: "draft", label: "Coming up", text: "Drafts the owner is testing", icon: Flag, test: (r) => !!r.view && displayStatus(r.view) === "draft" },
  { id: "demo", label: "Demo rounds", text: "Run by the Bakeoff team", icon: Shield, test: (r) => !!r.listing.demo },
];

/** The list page's artwork: three of the mark's arcs, each clearing the last. */
function HeroArt() {
  return (
    <svg className="list-hero-art" viewBox="0 0 420 260" aria-hidden="true">
      <circle cx="300" cy="96" r="120" fill="var(--accent)" opacity="0.08" />
      <path d="M20 230H410" stroke="var(--cream-strong)" strokeWidth="12" strokeLinecap="round" />
      <path d="M40 226C80 120 180 120 220 226" fill="none" stroke="var(--text)" strokeWidth="9" strokeLinecap="round" opacity="0.85" />
      <path d="M150 226C200 70 330 70 380 226" fill="none" stroke="var(--accent)" strokeWidth="9" strokeLinecap="round" />
      <circle cx="380" cy="226" r="14" fill="var(--amber)" />
      {Array.from({ length: 30 }, (_, i) => (
        <rect key={i} x={238 + (i % 10) * 16} y={20 + Math.floor(i / 10) * 16} width="11" height="11" rx="2.5" fill="var(--accent)" opacity={[0, 3, 4, 8, 11, 12, 17, 19, 22, 26, 28].includes(i) ? 0.85 : 0.14} />
      ))}
    </svg>
  );
}

export function Challenges() {
  const { network, setNetwork } = useSession();
  const { data, error } = useAsync(() => loadChallenges(network), network);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, (data ?? []).filter(f.test).length])) as Record<Filter, number>, [data]);
  const active = FILTERS.find((f) => f.id === filter)!;
  const q = query.trim().toLowerCase();
  const rows = (data ?? []).filter(active.test).filter((r) => !q || `${r.listing.title} ${r.listing.sponsor} ${r.listing.summary} ${r.listing.id}`.toLowerCase().includes(q));

  return (
    <div className="page">
      <div className="container page-body">
        <Reveal immediate className="list-hero">
          <div className="list-hero-copy">
            <h1>Challenges</h1>
            <p className="text-2">
              Each challenge is an AI workflow to improve: a goal, hidden test cases and a reward held by a NEAR contract.
              Builders and their agents compete, and the earliest result that meets every requirement is paid.
            </p>
            <div className="row">
              <Link to="/teams" className="btn btn-primary"><Plus /> Host a challenge</Link>
              <Link to="/how-it-works" className="btn">How it works</Link>
            </div>
          </div>
          <HeroArt />
        </Reveal>

        <div className="list-search">
          <Search className="search-icon" />
          <input className="search-input" type="search" placeholder={`Search challenges on ${network}`} aria-label="Search challenges" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="filter-tiles" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={f.id === filter} className={`filter-tile ${f.id === filter ? "active" : ""}`} onClick={() => setFilter(f.id)}>
              <span className="filter-tile-head"><strong>{f.label}</strong><f.icon /></span>
              <span className="muted small">{f.text}</span>
              <span className="filter-count mono">{data ? counts[f.id] : "–"}</span>
            </button>
          ))}
        </div>

        <div className="list-section-head">
          <h2><active.icon /> {active.label}</h2>
          <span className="muted small">{data ? `${rows.length} on ${network}` : `Reading ${network}…`}</span>
        </div>

        {error && <p className="coral">Could not read the challenges: {error.message}</p>}
        {data === null ? (
          <div className="ccard-grid">{[0, 1, 2].map((i) => <div key={i} className="ccard card skeleton" style={{ height: 380 }} />)}</div>
        ) : rows.length === 0 ? (
          <div className="empty card card-pad">
            <p>{data.length === 0 ? `No challenges are listed on ${network} yet.` : q ? `No challenge matches “${query.trim()}”.` : `No ${active.label.toLowerCase()} challenges on ${network}.`}</p>
            {network === "mainnet" && <button type="button" className="btn" onClick={() => setNetwork("testnet")}>See the testnet rounds</button>}
          </div>
        ) : (
          <div className="ccard-grid">{rows.map((row) => <ChallengeCard key={row.listing.id} summary={row} />)}</div>
        )}
      </div>
    </div>
  );
}
