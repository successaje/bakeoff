/** A NEAR account's record on the board: what it won, every result it submitted, and what it hosts. */

import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { Avatar, HostMark } from "../components/art.tsx";
import { ChallengeTile, STANDING } from "../components/board.tsx";
import { reasonText } from "../components/challenge.tsx";
import { External } from "../components/Icons.tsx";
import { CopyButton, explorer, Reveal } from "../components/ui.tsx";
import { loadAll, loadChallenges, recordsOf } from "../lib/data.ts";
import { ago, microDollars, percent, seconds } from "../lib/format.ts";
import { useAsync } from "../lib/hooks.ts";
import { rankAccounts, standingOf } from "../lib/leaderboard.ts";
import { formatNear, nsToDate, verdictMetrics } from "../lib/near.ts";
import { networkOf } from "../lib/registry.ts";
import { useSession } from "../lib/session.tsx";

export function Account() {
  const { id = "" } = useParams();
  const network = networkOf(id);
  const session = useSession();
  useEffect(() => {
    if (network !== session.network) session.setNetwork(network);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);
  const all = useAsync(() => loadAll(network), `all:${network}`);
  const summaries = useAsync(() => loadChallenges(network), network);
  const record = all.data ? rankAccounts(all.data.map(recordsOf)).find((r) => r.account === id) ?? null : undefined;
  const results = (all.data ?? []).flatMap((d) => d.evaluations.filter((e) => e.submitter === id).map((e) => ({ d, e })))
    .sort((a, b) => Number(BigInt(b.e.requested_at) - BigInt(a.e.requested_at)));
  const hosted = (summaries.data ?? []).filter((s) => s.view?.owner === id);

  return (
    <div className="page">
      <div className="container page-body">
        <Reveal immediate className="profile-head">
          <Avatar id={id} size={84} className="profile-avatar" />
          <div>
            <span className="mono-label">NEAR {network} account</span>
            <h1 className="break">{id}</h1>
            <p className="row">
              <a className="btn btn-sm" href={explorer(network, "address", id)} target="_blank" rel="noopener noreferrer"><External /> View on explorer</a>
              <CopyButton text={id} label="Copy account" />
            </p>
          </div>
        </Reveal>

        <div className="lb-stats">
          <div><strong>{record === undefined ? "–" : record?.wins ?? 0}</strong><span>Rewards won</span></div>
          <div><strong>{record === undefined ? "–" : record && record.earned > 0n ? formatNear(record.earned) : "0 NEAR"}</strong><span>Earned from contracts</span></div>
          <div><strong>{record === undefined ? "–" : record?.passes ?? 0}</strong><span>Met every requirement</span></div>
          <div><strong>{all.data ? results.length : "–"}</strong><span>Results, trials included</span></div>
        </div>

        <section className="doc-section">
          <h2>Results</h2>
          <div className="card card-pad">
            {all.data === null ? <div className="skeleton" style={{ height: 120 }} /> : results.length === 0 ? (
              <div className="empty"><p>No results from this account on the listed {network} challenges.</p><Link to="/challenges" className="btn">Find a challenge</Link></div>
            ) : (
              <div className="table-wrap">
                <table className="table board-table">
                  <thead><tr><th>Challenge</th><th>Result</th><th>Outcome</th><th className="num">Accuracy</th><th className="num">Cost / ticket</th><th className="num">p95</th><th>Submitted</th></tr></thead>
                  <tbody>
                    {results.map(({ d, e }) => {
                      const m = verdictMetrics(e);
                      const standing = standingOf(e, d.view.award?.evaluation ?? null);
                      return (
                        <tr key={`${d.listing.id}:${e.id}`}>
                          <td><Link to={`/challenges/${d.listing.id}`} className="who"><HostMark name={d.listing.sponsor} size={24} /><span>{d.listing.title}</span></Link></td>
                          <td><Link to={`/challenges/${d.listing.id}/results/${e.id}`} className="row-link">#{e.id}</Link>{e.eligible === false && <span className="badge trial">Owner's trial</span>}</td>
                          <td>
                            <span className={`chip ${STANDING[standing].tone}`}>{STANDING[standing].label}</span>
                            {(standing === "failed" || standing === "rejected") && e.reasons.length > 0 && <span className="small text-2 reason-note">{e.reasons.map(reasonText).join(", ")}</span>}
                          </td>
                          <td className="num">{percent(m?.accuracy_bp)}</td>
                          <td className="num">{microDollars(m?.cost_per_ticket_uusd)}</td>
                          <td className="num">{seconds(m?.p95_latency_ms)}</td>
                          <td className="small muted">{ago(nsToDate(e.requested_at))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {hosted.length > 0 && (
          <section className="doc-section profile-hosted">
            <h2>Hosted challenges</h2>
            <div className="tile-grid">{hosted.map((s) => <ChallengeTile key={s.listing.id} summary={s} />)}</div>
          </section>
        )}
      </div>
    </div>
  );
}
