/**
 * What a connected wallet can do on a challenge page: the owner funds,
 * opens and withdraws; anyone can retry a failed award payment. Funding
 * from other chains goes through 1Click on mainnet.
 */

import { h } from "./dom.ts";
import { relative, utc } from "./format.ts";
import { type ChallengeView, formatNear, type NearRpc, type Network, NETWORKS, nsToDate, parseNear } from "./near.ts";
import { FINAL_STATUSES, OneClick, type QuoteResponse, quoteRequest, type Token } from "./oneclick.ts";
import * as tx from "./transactions.ts";
import type { Wallet } from "./wallet.ts";

export interface FundingContext {
  network: Network;
  id: string;
  view: ChallengeView;
  rpc: NearRpc;
  wallet: Wallet;
  /** Re-reads the challenge after a transaction. */
  refresh: () => void;
}

/** A form row: input, button and a line for the outcome. */
function action(label: string, input: HTMLInputElement | null, run: (value: string) => Promise<string | void>): HTMLElement {
  const outcome = h("span", { class: "check-outcome" });
  const button = h("button", {
    type: "button",
    onclick: async () => {
      button.disabled = true;
      outcome.className = "check-outcome";
      outcome.textContent = "Waiting for your wallet…";
      try {
        outcome.textContent = (await run(input?.value ?? "")) ?? "Done.";
        outcome.classList.add("ok");
      } catch (error) {
        outcome.textContent = (error as Error).message;
        outcome.classList.add("error");
      } finally {
        button.disabled = false;
      }
    },
  }, label);
  return h("div", { class: "action" }, input, button, outcome);
}

const amountInput = (placeholder = "NEAR") => h("input", { type: "text", inputmode: "decimal", placeholder, size: "8" });

function deadlinePassed(view: ChallengeView): boolean {
  const closes = nsToDate(view.closes_at);
  return closes !== null && Date.now() >= closes.getTime();
}

export function sponsorPanel(ctx: FundingContext): HTMLElement {
  const { view, wallet, id } = ctx;
  const account = wallet.account;
  const isOwner = account === view.owner;
  const fundable = view.bounty !== undefined && (view.status === "Draft" || (view.status === "Open" && !deadlinePassed(view)));
  const sendThen = async (transactions: tx.Transaction[], done: string) => {
    await wallet.send(transactions);
    ctx.refresh();
    return done;
  };

  const rows: (HTMLElement | null)[] = [];
  if (!account) {
    rows.push(h("p", {}, "Connect the sponsor's wallet to fund, open or withdraw this challenge."));
  } else if (!isOwner) {
    rows.push(h("p", {}, `Only the sponsor, ${view.owner}, can fund this challenge. You are connected as ${account}.`));
  }

  if (view.bounty === undefined) {
    rows.push(h("p", { class: "muted" }, "This challenge was deployed before bounties existed, so it has nothing to fund."));
  }

  if (isOwner && fundable) {
    const amount = amountInput();
    rows.push(h("h3", {}, "Add to the bounty from this wallet"),
      action("Fund", amount, (value) => sendThen([tx.fund(id, parseNear(value))], `Added ${value} NEAR to the bounty.`)));
  }

  if (isOwner && view.status === "Draft") {
    const hours = h("input", { type: "number", min: "1", value: "72", size: "5" });
    rows.push(h("h3", {}, "Open the challenge"),
      h("p", { class: "muted" }, "Freezes the rules, evaluator and test set, and admits submissions from anyone until the deadline."),
      action("Open for this many hours", hours, (value) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) throw new Error("enter a number of hours");
        return sendThen([tx.open(id, Math.round(Date.now() + n * 3_600_000))], "The challenge is open.");
      }));
  }

  const bounty = BigInt(view.bounty ?? "0");
  if (isOwner && bounty > 0n) {
    if (view.status === "Draft" || (view.status === "Open" && deadlinePassed(view) && (view.pending ?? 0) === 0)) {
      rows.push(h("h3", {}, "Withdraw the bounty"),
        action(`Withdraw ${formatNear(bounty)}`, null, () => sendThen([tx.withdrawBounty(id)], "The bounty is on its way back to you.")));
    } else if (view.status === "Open") {
      const closes = nsToDate(view.closes_at);
      rows.push(h("p", { class: "muted" },
        deadlinePassed(view)
          ? `Withdrawal opens once the ${view.pending} pending evaluation(s) settle; any of them can still win.`
          : `If nobody wins, you can withdraw the bounty after the deadline, ${utc(closes)} (${relative(closes)}).`));
    }
  }

  const award = view.award;
  if (account && award && !award.paid && !award.in_flight) {
    rows.push(h("h3", {}, "Retry the award payment"),
      action(`Send ${formatNear(award.amount)} to ${award.winner}`, null, () => sendThen([tx.claimAward(id)], "Payment sent to the winner.")));
  }

  if (isOwner && fundable) rows.push(wnearPanel(ctx), crossChainPanel(ctx));

  return h("section", { class: "panel" }, h("h2", {}, "Sponsor"), ...rows);
}

/** Funding with wNEAR the sponsor already holds, such as a 1Click delivery. */
function wnearPanel(ctx: FundingContext): HTMLElement {
  const wrap = NETWORKS[ctx.network].wrap;
  const box = h("div", {}, h("p", { class: "muted" }, "Checking your wNEAR balance…"));
  void ctx.rpc.ftBalance(wrap, ctx.wallet.account!).then(
    (balance) => {
      const held = BigInt(balance);
      if (held === 0n) {
        box.replaceChildren();
        return;
      }
      box.replaceChildren(
        h("h3", {}, "Add your wNEAR to the bounty"),
        h("p", {}, `You hold ${formatNear(held).replace("NEAR", "wNEAR")} on ${wrap}. One approval unwraps it and funds the challenge.`),
        action(`Unwrap and fund ${formatNear(held)}`, null, async () => {
          await ctx.wallet.send(tx.unwrapAndFund(wrap, ctx.id, held));
          ctx.refresh();
          return "Unwrapped and added to the bounty.";
        }),
      );
    },
    () => box.replaceChildren(),
  );
  return box;
}

const PENDING_KEY = "bakeoff:1click";

interface PendingSwap {
  challenge: string;
  depositAddress: string;
  depositMemo?: string;
  quote: QuoteResponse["quote"];
  symbol: string;
  blockchain: string;
}

function savedSwap(challenge: string): PendingSwap | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as PendingSwap | null;
    return saved?.challenge === challenge ? saved : null;
  } catch {
    return null;
  }
}

function saveSwap(swap: PendingSwap | null): void {
  try {
    if (swap) localStorage.setItem(PENDING_KEY, JSON.stringify(swap));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage can be unavailable; the swap still completes, only a reload loses track of it.
  }
}

/** Fund from any chain: 1Click swaps to wNEAR delivered to the sponsor's own account. */
function crossChainPanel(ctx: FundingContext): HTMLElement {
  const section = h("div", { class: "crosschain" }, h("h3", {}, "Fund from another chain"));
  if (ctx.network !== "mainnet") {
    section.append(h("p", { class: "muted" },
      "On mainnet, NEAR Intents' 1Click swaps tokens from other chains into wNEAR in your account, which the step above then adds to the bounty. NEAR Intents has no testnet, so this is mainnet only.",
    ));
    return section;
  }
  const account = ctx.wallet.account!;
  const oneClick = new OneClick();
  const wrap = NETWORKS.mainnet.wrap;
  const body = h("div", {});
  section.append(
    h("p", { class: "muted" },
      "1Click swaps the token you send into exactly the wNEAR you ask for, delivered to ", h("strong", {}, account),
      ". If the swap fails, the refund goes to that account's NEAR Intents balance. 1Click charges a 0.25% fee.",
    ),
    body,
  );

  const track = (swap: PendingSwap) => {
    const status = h("p", { class: "check-outcome" }, "Waiting for your deposit…");
    body.replaceChildren(
      h("p", {}, "Send exactly ", h("strong", {}, `${swap.quote.amountInFormatted} ${swap.symbol}`), ` on ${swap.blockchain} to:`),
      h("pre", { class: "deposit" }, swap.depositAddress),
      swap.depositMemo ? h("p", {}, "with memo ", h("strong", { class: "mono" }, swap.depositMemo)) : "",
      h("p", { class: "muted" }, `The address stays active until ${utc(swap.quote.deadline ? new Date(swap.quote.deadline) : null)}. Delivery takes about ${swap.quote.timeEstimate} s after your deposit confirms.`),
      status,
      h("button", { type: "button", class: "secondary", onclick: () => { saveSwap(null); body.replaceChildren(quoteForm()); } }, "Start over"),
    );
    const poll = async () => {
      if (!section.isConnected) return;
      try {
        const { status: state, swapDetails } = await oneClick.status(swap.depositAddress, swap.depositMemo);
        status.textContent = {
          PENDING_DEPOSIT: "Waiting for your deposit…",
          KNOWN_DEPOSIT_TX: "Deposit seen; waiting for it to confirm…",
          PROCESSING: "Swapping…",
          SUCCESS: `Delivered ${swap.quote.amountOutFormatted} wNEAR to ${account}.`,
          INCOMPLETE_DEPOSIT: "The deposit was less than the quote asked for; 1Click will refund it.",
          REFUNDED: `Refunded${swapDetails.refundReason ? `: ${swapDetails.refundReason}` : ""}.`,
          FAILED: "The swap failed; 1Click will refund the deposit.",
        }[state];
        if (FINAL_STATUSES.includes(state)) {
          saveSwap(null);
          status.classList.add(state === "SUCCESS" ? "ok" : "error");
          if (state === "SUCCESS") {
            body.append(action(`Unwrap and fund ${formatNear(swap.quote.amountOut)}`, null, async () => {
              const held = BigInt(await ctx.rpc.ftBalance(wrap, account));
              const amount = held < BigInt(swap.quote.amountOut) ? held : BigInt(swap.quote.amountOut);
              await ctx.wallet.send(tx.unwrapAndFund(wrap, ctx.id, amount));
              ctx.refresh();
              return `Added ${formatNear(amount)} to the bounty.`;
            }));
          }
          return;
        }
      } catch (error) {
        status.textContent = (error as Error).message;
      }
      setTimeout(poll, 5_000);
    };
    void poll();
  };

  const quoteForm = (): HTMLElement => {
    const select = h("select", {}, h("option", { value: "" }, "Loading tokens…"));
    const amount = amountInput("NEAR to add");
    const details = h("div", {});
    let tokens: Token[] = [];
    void oneClick.tokens().then(
      (list) => {
        tokens = list;
        select.replaceChildren(h("option", { value: "" }, "Pay with…"), ...list.map((t) => h("option", { value: t.assetId }, `${t.symbol} on ${t.blockchain}`)));
      },
      (error: Error) => select.replaceChildren(h("option", { value: "" }, `Could not load tokens: ${error.message}`)),
    );
    const request = (dry: boolean) => {
      const token = tokens.find((t) => t.assetId === select.value);
      if (!token) throw new Error("choose the token you will pay with");
      return { token, request: quoteRequest({ originAsset: token.assetId, amountYocto: parseNear(amount.value), recipient: account, dry }) };
    };
    return h("div", {},
      h("div", { class: "action" }, select, amount),
      action("Get a quote", null, async () => {
        const { token, request: dryRequest } = request(true);
        const registered = await ctx.rpc.storageBalance(wrap, account);
        const { quote } = await oneClick.quote(dryRequest);
        details.replaceChildren(
          h("p", {}, `About ${quote.amountInFormatted} ${token.symbol} (≈ $${Number(quote.amountInUsd).toFixed(2)}) buys exactly ${quote.amountOutFormatted} wNEAR.`),
          registered !== null ? "" : h("div", {},
              h("p", {}, `${account} is not registered with ${wrap} yet, so it cannot receive wNEAR. Register first (0.00125 NEAR, refundable):`),
              action("Register for wNEAR", null, async () => {
                await ctx.wallet.send([tx.registerWnear(wrap, account)]);
                return "Registered. Now get the deposit address.";
              })),
          action("Get the deposit address", null, async () => {
            const { token: chosen, request: liveRequest } = request(false);
            const response = await oneClick.quote(liveRequest);
            if (!response.quote.depositAddress) throw new Error("1Click returned no deposit address");
            const swap: PendingSwap = {
              challenge: ctx.id,
              depositAddress: response.quote.depositAddress,
              depositMemo: response.quote.depositMemo,
              quote: response.quote,
              symbol: chosen.symbol,
              blockchain: chosen.blockchain,
            };
            saveSwap(swap);
            track(swap);
          }),
        );
        return "Quote ready.";
      }),
      details,
    );
  };

  const saved = savedSwap(ctx.id);
  if (saved) track(saved);
  else body.append(quoteForm());
  return section;
}
