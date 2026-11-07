import { h, link } from "./dom.ts";
import { microDollars, percent, relative, seconds, shortHash, utc } from "./format.ts";
import {
  acceptingSubmissions, type ChallengeView, challengeGates, type EvaluationView, formatNear,
  type Gates, type Network, NETWORKS, nsToDate, sha256Hex, verdictMetrics,
} from "./near.ts";

export interface Page {
  network: Network;
  explorer: string;
}

const STATUS_TEXT: Record<string, string> = {
  Draft: "Draft: trial runs only",
  Open: "Open for submissions",
  Awarded: "Awarded",
  Closed: "Closed without a winner",
};

export function statusChip(view: ChallengeView): HTMLElement {
  const open = acceptingSubmissions(view);
  const label = view.status === "Open" && !open ? "Deadline passed" : STATUS_TEXT[view.status] ?? view.status;
  return h("span", { class: `chip chip-${view.status.toLowerCase()}` }, label);
}

function gateList(gates: Gates | null): HTMLElement {
  if (!gates) return h("p", { class: "muted" }, "No gates in the rules.");
  return h("ul", { class: "gates" },
    h("li", {}, "Accuracy at least ", h("strong", {}, percent(gates.min_accuracy_bp))),
    h("li", {}, "Cost at most ", h("strong", {}, microDollars(gates.max_cost_per_ticket_uusd)), " per ticket"),
    h("li", {}, "p95 latency at most ", h("strong", {}, seconds(gates.max_p95_latency_ms))),
    h("li", {}, gates.max_leaks === 0 ? "No card-number leaks" : `At most ${gates.max_leaks} leaks`),
  );
}

export function boardView(page: Page, rows: { id: string; view?: ChallengeView; error?: string }[]): HTMLElement {
  return h("section", {},
    h("h1", {}, "Challenges"),
    h("p", { class: "lede" },
      "Each challenge is a NEAR contract holding a business's rules, a commitment to its sealed test set and a bounty. ",
      "Candidates are scored inside an OutLayer TEE; the first to clear every gate is paid by the contract.",
    ),
    rows.length === 0 && h("p", { class: "muted" }, `No challenges are listed for ${page.network} yet.`),
    h("div", { class: "cards" },
      ...rows.map(({ id, view, error }) => {
        if (!view) return h("article", { class: "card" }, h("h2", {}, id), h("p", { class: "error" }, error ?? "Could not load"));
        const closes = nsToDate(view.closes_at);
        return h("a", { class: "card", href: `#/${page.network}/${id}` },
          h("div", { class: "card-head" }, h("h2", {}, id), statusChip(view)),
          h("dl", { class: "facts" },
            h("dt", {}, "Bounty"), h("dd", {}, view.award ? `${formatNear(view.award.amount)} awarded` : view.bounty ? formatNear(view.bounty) : "–"),
            h("dt", {}, "Deadline"), h("dd", {}, closes ? `${utc(closes)} (${relative(closes)})` : "Not open yet"),
            h("dt", {}, "Evaluations"), h("dd", {}, String(view.evaluations)),
          ),
          gateList(challengeGates(view)),
        );
      }),
    ),
  );
}

function evaluationsTable(page: Page, evaluations: EvaluationView[], highlight: Set<number>): HTMLElement {
  if (evaluations.length === 0) return h("p", { class: "muted" }, "No submissions yet.");
  return h("div", { class: "table-wrap" },
    h("table", {},
      h("thead", {}, h("tr", {},
        ...["#", "Submitter", "Result", "Accuracy", "Cost / ticket", "p95", "Leaks", "Invalid", "Config", "Settled"].map((c) => h("th", {}, c)),
      )),
      h("tbody", {},
        ...[...evaluations].reverse().map((e) => {
          const m = verdictMetrics(e);
          const result = e.status === "Failed" || e.status === "Rejected" ? `${e.status}: ${e.reasons.join(", ")}` : e.status;
          return h("tr", { class: highlight.has(e.id) ? "highlight" : undefined, id: `evaluation-${e.id}` },
            h("td", {}, String(e.id)),
            h("td", {},
              link(`${page.explorer}/address/${e.submitter}`, e.submitter),
              e.eligible === false ? h("span", { class: "tag" }, "trial") : null,
            ),
            h("td", { class: `result result-${e.status.toLowerCase()}` }, result),
            h("td", {}, percent(m?.accuracy_bp)),
            h("td", {}, microDollars(m?.cost_per_ticket_uusd)),
            h("td", {}, seconds(m?.p95_latency_ms)),
            h("td", {}, m?.leaks === undefined ? "–" : String(m.leaks)),
            h("td", {}, m?.invalid_answers === undefined ? "–" : String(m.invalid_answers)),
            h("td", { class: "mono", title: e.config_sha256 }, shortHash(e.config_sha256)),
            h("td", {}, utc(nsToDate(e.settled_at))),
          );
        }),
      ),
    ),
  );
}

/** A button that runs a check in the browser and shows its outcome beside it. */
function check(label: string, run: () => Promise<string>): HTMLElement {
  const outcome = h("span", { class: "check-outcome" });
  const button = h("button", {
    type: "button",
    class: "secondary",
    onclick: async () => {
      button.disabled = true;
      outcome.className = "check-outcome";
      outcome.textContent = "Checking…";
      try {
        outcome.textContent = await run();
        outcome.classList.add("ok");
      } catch (error) {
        outcome.textContent = (error as Error).message;
        outcome.classList.add("error");
      } finally {
        button.disabled = false;
      }
    },
  }, label);
  return h("div", { class: "check" }, button, outcome);
}

function commitments(view: ChallengeView): HTMLElement {
  return h("section", { class: "panel" },
    h("h2", {}, "Commitments"),
    h("p", {}, "A verdict is recorded only if it names these exact rules, this candidate and this test set. Check the first two here:"),
    h("dl", { class: "facts wide" },
      h("dt", {}, "Rules"), h("dd", { class: "mono" }, view.rules_sha256),
      h("dt", {}, "Evaluator build"), h("dd", { class: "mono" }, view.evaluator.sha256, " ", link(view.evaluator.url, "download")),
      h("dt", {}, "Sealed test set"), h("dd", { class: "mono" }, view.test_set_sha256),
    ),
    check("Hash the rules", async () => {
      const actual = await sha256Hex(view.rules_json);
      if (actual !== view.rules_sha256) throw new Error(`The rules hash to ${actual}, not the committed value`);
      return "The rules the contract serves hash to its commitment.";
    }),
    check("Download and hash the evaluator", async () => {
      const response = await fetch(view.evaluator.url);
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const actual = await sha256Hex(bytes);
      if (actual !== view.evaluator.sha256) throw new Error(`The download hashes to ${actual}, not the pinned build`);
      return `The ${(bytes.byteLength / 1024).toFixed(0)} KB build at that URL is the pinned one. OutLayer runs it by this hash.`;
    }),
    h("p", { class: "muted" },
      "The sealed test set stays secret: only its hash is public. Each verdict carries the hash of the set it scored, and the contract rejects any verdict whose hash differs.",
    ),
  );
}

function findConfig(evaluations: EvaluationView[], onFound: (ids: Set<number>) => void): HTMLElement {
  const input = h("textarea", { rows: "4", placeholder: "Paste a candidate config, exactly as submitted", spellcheck: "false" });
  const outcome = h("p", { class: "check-outcome" });
  return h("section", { class: "panel" },
    h("h2", {}, "Find a submission"),
    h("p", {}, "Every verdict records the SHA-256 of the config it scored. Paste a config to find its evaluations."),
    input,
    h("button", {
      type: "button",
      class: "secondary",
      onclick: async () => {
        const text = input.value;
        // Pasting often drops or adds the file's final newline.
        const variants = [text, `${text.replace(/\n+$/, "")}\n`, text.replace(/\n+$/, "")];
        const hashes = new Set(await Promise.all(variants.map((v) => sha256Hex(v))));
        const ids = new Set(evaluations.filter((e) => hashes.has(e.config_sha256)).map((e) => e.id));
        outcome.textContent = ids.size
          ? `Matches evaluation ${[...ids].join(", ")}.`
          : "No evaluation was scored on this config.";
        outcome.className = `check-outcome ${ids.size ? "ok" : "error"}`;
        onFound(ids);
        document.getElementById(`evaluation-${[...ids][0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      },
    }, "Find"),
    outcome,
  );
}

function competePanel(page: Page, id: string, view: ChallengeView): HTMLElement {
  const open = acceptingSubmissions(view);
  return h("section", { class: "panel" },
    h("h2", {}, "Compete"),
    h("p", {},
      open
        ? "Contributors and their agents compete through the Bakeoff MCP server: read the gates and labeling guide, score candidates on the public practice set with this challenge's own evaluator build, and submit the best one."
        : "This challenge is not taking submissions. Its practice set and verdicts stay public, and the MCP server can still score candidates against it.",
    ),
    h("pre", {}, [
      "claude mcp add bakeoff \\",
      `  -e BAKEOFF_MCP_CONFIG=<path to repo>/mcp/bakeoff.${page.network}.json \\`,
      `  -e BAKEOFF_CHALLENGES=${id} \\`,
      "  -e BAKEOFF_ACCOUNT=<your account> \\",
      "  -e BAKEOFF_LLM_API_KEY=<your NEAR AI key> \\",
      "  -- node <path to repo>/mcp/dist/index.js",
    ].join("\n")),
    h("p", { class: "muted" }, "A submission costs 0.035 NEAR plus gas, most of it refunded. The config becomes public on-chain."),
  );
}

export function challengeView(
  page: Page,
  id: string,
  view: ChallengeView,
  evaluations: EvaluationView[],
  sponsor: HTMLElement | null,
): HTMLElement {
  const closes = nsToDate(view.closes_at);
  const gates = challengeGates(view);
  const table = h("div", {}, evaluationsTable(page, evaluations, new Set()));
  const award = view.award;
  return h("section", {},
    h("p", {}, link(`#/${page.network}`, `← All ${page.network} challenges`, false)),
    h("div", { class: "title-row" }, h("h1", {}, id), statusChip(view)),
    h("p", { class: "muted" }, "Sponsor ", link(`${page.explorer}/address/${view.owner}`, view.owner), " · ", link(`${page.explorer}/address/${id}`, "contract on the explorer")),
    h("div", { class: "stats" },
      stat("Bounty", award ? formatNear(award.amount) : view.bounty ? formatNear(view.bounty) : "–", award ? "awarded" : "in escrow"),
      stat("Deadline", closes ? utc(closes) : "–",
        view.status === "Awarded" ? "no longer applies: awarded" : view.status === "Closed" ? "passed without a winner" : closes ? relative(closes) : "set when opened"),
      stat("Evaluations", String(view.evaluations), view.pending ? `${view.pending} pending` : "all settled"),
    ),
    award && h("section", { class: "panel award" },
      h("h2", {}, award.paid ? "Bounty paid" : "Bounty awarded"),
      h("p", {},
        link(`${page.explorer}/address/${award.winner}`, award.winner),
        ` won ${formatNear(award.amount)} with evaluation ${award.evaluation}`,
        award.paid ? ", paid by the contract with the verdict." : award.in_flight ? "; the payment is on its way." : "; the payment failed and can be retried below.",
      ),
    ),
    h("section", { class: "panel" }, h("h2", {}, "Gates"), gateList(gates)),
    h("section", { class: "panel" }, h("h2", {}, "Verdicts"), table),
    findConfig(evaluations, (ids) => table.replaceChildren(evaluationsTable(page, evaluations, ids))),
    commitments(view),
    sponsor,
    competePanel(page, id, view),
  );
}

function stat(label: string, value: string, note: string): HTMLElement {
  return h("div", { class: "stat" }, h("span", { class: "stat-label" }, label), h("strong", {}, value), h("span", { class: "muted" }, note));
}

export function explorerFor(network: Network): string {
  return NETWORKS[network].explorer;
}
