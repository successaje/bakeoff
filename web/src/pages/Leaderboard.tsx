/** Every builder across the listed challenges, ranked by rewards won. */

import { Link } from "react-router";
import { Avatar } from "../components/art.tsx";
import { Medal } from "../components/board.tsx";
import { Reveal } from "../components/ui.tsx";
import { loadAll, recordsOf } from "../lib/data.ts";
import { ago } from "../lib/format.ts";
import { useAsync } from "../lib/hooks.ts";
import { rankAccounts } from "../lib/leaderboard.ts";
import { formatNear } from "../lib/near.ts";
import { useSession } from "../lib/session.tsx";

function PodiumArt() {
  return (
    <svg className="list-hero-art" viewBox="0 0 420 260" aria-hidden="true">
      <circle cx="210" cy="90" r="110" fill="var(--gold)" opacity="0.1" />
      <rect x="60" y="150" width="100" height="80" rx="10" fill="var(--cream-strong)" />
      <rect x="160" y="100" width="100" height="130" rx="10" fill="var(--text)" opacity="0.9" />
      <rect x="260" y="180" width="100" height="50" rx="10" fill="var(--cream-strong)" />
      <circle cx="110" cy="128" r="16" fill="var(--silver)" />
      <circle cx="210" cy="76" r="20" fill="var(--gold)" />
      <circle cx="310" cy="158" r="14" fill="var(--bronze)" />
      <path d="M30 232H390" stroke="var(--cream-strong)" strokeWidth="8" strokeLinecap="round" />
    </svg>
  );
}

export function Leaderboard() {
  const { network, setNetwork } = useSession();
  const { data, error } = useAsync(() => loadAll(network), `all:${network}`);
  const ranked = data ? rankAccounts(data.map(recordsOf)) : null;
  const paid = ranked?.reduce((sum, r) => sum + r.earned, 0n) ?? 0n;
  return (
    <div className="page">
      <div className="container page-body">
        <Reveal immediate className="list-hero">
          <div className="list-hero-copy">
            <h1>Leaderboard</h1>
            <p className="text-2">Every builder who has competed in a listed challenge on {network}, ranked by rewards won, then by results that met every requirement. Owners' trial runs don't count.</p>
            <div className="row">
              <Link to="/challenges" className="btn btn-primary">Find a challenge</Link>
              <Link to="/builders" className="btn">How to compete</Link>
            </div>
          </div>
          <PodiumArt />
        </Reveal>

        <div className="lb-stats">
          <div><strong>{ranked ? ranked.length : "–"}</strong><span>Builders</span></div>
          <div><strong>{ranked ? formatNear(paid) : "–"}</strong><span>Paid to winners</span></div>
          <div><strong>{ranked ? ranked.reduce((n, r) => n + r.passes, 0) : "–"}</strong><span>Results that met every requirement</span></div>
          <div><strong>{data ? data.length : "–"}</strong><span>Challenges counted</span></div>
        </div>

        {error && <p className="coral">Could not read the challenges: {error.message}</p>}
        <div className="card card-pad">
          {ranked === null ? (
            <div className="skeleton" style={{ height: 180 }} />
          ) : ranked.length === 0 ? (
            <div className="empty">
              <p>No builder has competed on {network} yet.</p>
              {network === "mainnet" && <button type="button" className="btn" onClick={() => setNetwork("testnet")}>See testnet</button>}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table board-table">
                <thead>
                  <tr><th>#</th><th>Builder</th><th className="num">Rewards won</th><th className="num">Earned</th><th className="num">Met every requirement</th><th className="num">Results</th><th className="num">Challenges</th><th className="num">Best cost cut</th><th>Last active</th></tr>
                </thead>
                <tbody>
                  {ranked.map((r) => (
                    <tr key={r.account} className={r.rank === 1 && r.wins > 0 ? "winner" : ""}>
                      <td><Medal rank={r.wins > 0 || r.passes > 0 ? r.rank : null} /></td>
                      <td><Link to={`/accounts/${r.account}`} className="who"><Avatar id={r.account} size={26} /><span>{r.account}</span></Link></td>
                      <td className="num">{r.wins}</td>
                      <td className="num">{r.earned > 0n ? formatNear(r.earned) : "–"}</td>
                      <td className="num">{r.passes}</td>
                      <td className="num">{r.results}</td>
                      <td className="num">{r.challenges}</td>
                      <td className="num">{r.bestCut !== null ? `${r.bestCut}%` : "–"}</td>
                      <td className="small muted">{ago(r.last)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
