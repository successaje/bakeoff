import { useMemo, useState } from "react";
import { ChallengeCard } from "../components/challenge.tsx";
import { Reveal, Tabs } from "../components/ui.tsx";
import { displayStatus } from "../components/ui.tsx";
import { loadChallenges } from "../lib/data.ts";
import { useAsync } from "../lib/hooks.ts";
import { useSession } from "../lib/session.tsx";

type Filter = "all" | "open" | "awarded" | "draft";

export function Challenges() {
  const { network, setNetwork } = useSession();
  const { data, error } = useAsync(() => loadChallenges(network), network);
  const [filter, setFilter] = useState<Filter>("all");
  const counts = useMemo(() => {
    const c = { all: 0, open: 0, awarded: 0, draft: 0 };
    for (const row of data ?? []) {
      c.all += 1;
      const status = row.view ? displayStatus(row.view) : null;
      if (status === "open") c.open += 1;
      if (status === "awarded") c.awarded += 1;
      if (status === "draft") c.draft += 1;
    }
    return c;
  }, [data]);
  const rows = (data ?? []).filter((row) => filter === "all" || (row.view && displayStatus(row.view) === filter));

  return (
    <div className="page">
      <div className="page-hero grid-bg-wrap">
        <div className="grid-bg page-grid" aria-hidden="true" />
        <div className="container">
          <Reveal immediate>
            <span className="eyebrow">Challenges on {network}</span>
            <h1 className="page-title">Every goal, every <span className="serif">result</span>.</h1>
            <p className="page-lede">Each challenge is an AI workflow to improve, with requirements, hidden test cases and a reward held by a NEAR contract. Pick one to see the goal, the results and how to take part.</p>
          </Reveal>
        </div>
      </div>
      <div className="container page-body">
        <div className="toolbar">
          <Tabs
            tabs={[
              { id: "all", label: "All", count: counts.all },
              { id: "open", label: "Open", count: counts.open },
              { id: "awarded", label: "Awarded", count: counts.awarded },
              { id: "draft", label: "Draft", count: counts.draft },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </div>
        {error && <p className="coral">Could not read the challenges: {error.message}</p>}
        {data === null ? (
          <div className="card-grid">{[0, 1, 2].map((i) => <div key={i} className="card skeleton-card skeleton" />)}</div>
        ) : rows.length === 0 ? (
          <div className="empty card card-pad">
            <p>{data.length === 0 ? `No challenges are listed on ${network} yet.` : "No challenges match this filter."}</p>
            {network === "mainnet" && <button type="button" className="btn" onClick={() => setNetwork("testnet")}>See the testnet rounds</button>}
          </div>
        ) : (
          <div className="card-grid">{rows.map((row, i) => <ChallengeCard key={row.listing.id} summary={row} index={i} />)}</div>
        )}
      </div>
    </div>
  );
}
