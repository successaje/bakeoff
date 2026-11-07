/**
 * What a connected wallet can do on a challenge: the owner funds, opens and
 * withdraws; anyone can retry a failed award payment. On mainnet, a sponsor
 * can fund from another chain through 1Click.
 */

import { useEffect, useState } from "react";
import { relative, utc } from "../lib/format.ts";
import { type ChallengeView, formatNear, type NearRpc, type Network, NETWORKS, nsToDate, parseNear } from "../lib/near.ts";
import { FINAL_STATUSES, OneClick, type Quote, quoteRequest, type SwapStatus, type Token } from "../lib/oneclick.ts";
import { useSession } from "../lib/session.tsx";
import * as tx from "../lib/transactions.ts";
import { Coins, Wallet } from "./Icons.tsx";
import { ActionButton, CopyButton } from "./ui.tsx";

interface Props {
  id: string;
  network: Network;
  view: ChallengeView;
  rpc: NearRpc;
  onChanged: () => void;
}

function deadlinePassed(view: ChallengeView): boolean {
  const closes = nsToDate(view.closes_at);
  return closes !== null && Date.now() >= closes.getTime();
}

export function SponsorPanel({ id, network, view, rpc, onChanged }: Props) {
  const session = useSession();
  const { account, signIn, send } = session;
  const [amount, setAmount] = useState("1");
  const [hours, setHours] = useState("72");
  const isOwner = account === view.owner;
  const wrongNetwork = session.network !== network;
  const fundable = view.bounty !== undefined && (view.status === "Draft" || (view.status === "Open" && !deadlinePassed(view)));
  const bounty = BigInt(view.bounty ?? "0");
  const sendThen = async (transactions: tx.Transaction[], done: string) => {
    await send(transactions);
    onChanged();
    return done;
  };

  if (wrongNetwork) {
    return (
      <div className="panel-empty">
        <p>This challenge is on {network}; your wallet is set to {session.network}.</p>
        <button type="button" className="btn" onClick={() => session.setNetwork(network)}>Switch to {network}</button>
      </div>
    );
  }
  if (!account) {
    return (
      <div className="panel-empty">
        <span className="panel-empty-icon"><Wallet /></span>
        <p>Connect the sponsor's wallet to fund, open or withdraw this challenge.</p>
        <button type="button" className="btn btn-primary" onClick={() => void signIn()}>Connect wallet</button>
      </div>
    );
  }

  const award = view.award;
  return (
    <div className="sponsor">
      {!isOwner && (
        <p className="notice">Only the sponsor, <strong className="break">{view.owner}</strong>, can fund this challenge. You are connected as <strong className="break">{account}</strong>.</p>
      )}
      {view.bounty === undefined && <p className="notice">This challenge was deployed before bounties existed, so it has nothing to fund.</p>}

      {isOwner && fundable && (
        <div className="sponsor-block">
          <h4>Add to the bounty</h4>
          <p className="muted small">Paid from your wallet into the contract's escrow.</p>
          <div className="row">
            <div className="input-suffix"><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in NEAR" /><span>NEAR</span></div>
            <ActionButton primary label="Fund" run={() => sendThen([tx.fund(id, parseNear(amount))], `Added ${amount} NEAR to the bounty.`)} />
          </div>
        </div>
      )}

      {isOwner && view.status === "Draft" && (
        <div className="sponsor-block">
          <h4>Open the challenge</h4>
          <p className="muted small">Freezes the rules, evaluator and test set, and admits submissions from anyone until the deadline.</p>
          <div className="row">
            <div className="input-suffix"><input className="input" type="number" min="1" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Hours open" /><span>hours</span></div>
            <ActionButton label="Open" run={() => {
              const n = Number(hours);
              if (!Number.isFinite(n) || n <= 0) throw new Error("enter a number of hours");
              return sendThen([tx.open(id, Math.round(Date.now() + n * 3_600_000))], "The challenge is open.");
            }} />
          </div>
        </div>
      )}

      {isOwner && bounty > 0n && (
        view.status === "Draft" || (view.status === "Open" && deadlinePassed(view) && (view.pending ?? 0) === 0) ? (
          <div className="sponsor-block">
            <h4>Withdraw the bounty</h4>
            <ActionButton label={`Withdraw ${formatNear(bounty)}`} run={() => sendThen([tx.withdrawBounty(id)], "The bounty is on its way back to you.")} />
          </div>
        ) : view.status === "Open" ? (
          <p className="notice">
            {deadlinePassed(view)
              ? `Withdrawal opens once the ${view.pending} pending evaluation(s) settle; any of them can still win.`
              : `If nobody wins, you can withdraw the bounty after the deadline, ${utc(nsToDate(view.closes_at))} (${relative(nsToDate(view.closes_at))}).`}
          </p>
        ) : null
      )}

      {award && !award.paid && !award.in_flight && (
        <div className="sponsor-block">
          <h4>Retry the award payment</h4>
          <ActionButton label={`Send ${formatNear(award.amount)} to ${award.winner}`} run={() => sendThen([tx.claimAward(id)], "Payment sent to the winner.")} />
        </div>
      )}

      {isOwner && fundable && <WnearBlock id={id} network={network} rpc={rpc} account={account} onChanged={onChanged} />}
      {isOwner && fundable && <CrossChain id={id} network={network} rpc={rpc} account={account} onChanged={onChanged} />}
      {view.status === "Awarded" && <p className="notice">This challenge is settled: the bounty was awarded, so there is nothing left to fund.</p>}
    </div>
  );
}

function WnearBlock({ id, network, rpc, account, onChanged }: { id: string; network: Network; rpc: NearRpc; account: string; onChanged: () => void }) {
  const { send } = useSession();
  const wrap = NETWORKS[network].wrap;
  const [held, setHeld] = useState<bigint>(0n);
  useEffect(() => {
    rpc.ftBalance(wrap, account).then((b) => setHeld(BigInt(b)), () => setHeld(0n));
  }, [rpc, wrap, account]);
  if (held === 0n) return null;
  return (
    <div className="sponsor-block">
      <h4>Add your wNEAR</h4>
      <p className="muted small">You hold {formatNear(held).replace("NEAR", "wNEAR")} on {wrap}. One approval unwraps it and funds the challenge.</p>
      <ActionButton label={`Unwrap and fund ${formatNear(held)}`} run={async () => {
        await send(tx.unwrapAndFund(wrap, id, held));
        onChanged();
        return "Unwrapped and added to the bounty.";
      }} />
    </div>
  );
}

const PENDING_KEY = "bakeoff:1click";

interface PendingSwap {
  challenge: string;
  depositAddress: string;
  depositMemo?: string;
  quote: Quote;
  symbol: string;
  blockchain: string;
}

function readSwap(challenge: string): PendingSwap | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as PendingSwap | null;
    return saved?.challenge === challenge ? saved : null;
  } catch {
    return null;
  }
}

function writeSwap(swap: PendingSwap | null): void {
  try {
    if (swap) localStorage.setItem(PENDING_KEY, JSON.stringify(swap));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Without storage the swap still completes; only a reload loses track of it.
  }
}

const STATUS_TEXT: Record<SwapStatus, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit",
  KNOWN_DEPOSIT_TX: "Deposit seen, waiting for it to confirm",
  PROCESSING: "Swapping",
  SUCCESS: "Delivered",
  INCOMPLETE_DEPOSIT: "The deposit was less than quoted; 1Click will refund it",
  REFUNDED: "Refunded",
  FAILED: "The swap failed; 1Click will refund the deposit",
};

/** Fund from any chain: 1Click delivers wNEAR to the sponsor's own account. */
function CrossChain({ id, network, rpc, account, onChanged }: { id: string; network: Network; rpc: NearRpc; account: string; onChanged: () => void }) {
  const { send } = useSession();
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [asset, setAsset] = useState("");
  const [amount, setAmount] = useState("1");
  const [quote, setQuote] = useState<{ quote: Quote; token: Token; registered: boolean } | null>(null);
  const [swap, setSwap] = useState<PendingSwap | null>(() => readSwap(id));
  const [status, setStatus] = useState<SwapStatus | null>(null);
  const oneClick = new OneClick();
  const wrap = NETWORKS.mainnet.wrap;

  useEffect(() => {
    if (network !== "mainnet") return;
    new OneClick().tokens().then(setTokens, () => setTokens([]));
  }, [network]);

  useEffect(() => {
    if (!swap) return;
    let live = true;
    const poll = async () => {
      try {
        const { status: next } = await new OneClick().status(swap.depositAddress, swap.depositMemo);
        if (!live) return;
        setStatus(next);
        if (FINAL_STATUSES.includes(next)) return;
      } catch {
        // Try again on the next tick.
      }
      if (live) setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      live = false;
    };
  }, [swap]);

  if (network !== "mainnet") {
    return (
      <div className="sponsor-block subtle">
        <h4><Coins /> Fund from another chain</h4>
        <p className="muted small">On mainnet, NEAR Intents' 1Click swaps about 200 tokens on about 40 chains into wNEAR in your account, which then funds the bounty in one approval. NEAR Intents has no testnet, so this is mainnet only.</p>
      </div>
    );
  }

  const request = (dry: boolean) => {
    const token = tokens?.find((t) => t.assetId === asset);
    if (!token) throw new Error("choose the token you will pay with");
    return { token, request: quoteRequest({ originAsset: token.assetId, amountYocto: parseNear(amount), recipient: account, dry }) };
  };

  if (swap) {
    return (
      <div className="sponsor-block">
        <h4><Coins /> Fund from another chain</h4>
        <p>Send exactly <strong>{swap.quote.amountInFormatted} {swap.symbol}</strong> on {swap.blockchain} to:</p>
        <pre className="code deposit">{swap.depositAddress}<CopyButton text={swap.depositAddress} label="Copy address" /></pre>
        {swap.depositMemo && <p>with memo <strong className="mono">{swap.depositMemo}</strong></p>}
        <p className="muted small">The address stays active until {utc(swap.quote.deadline ? new Date(swap.quote.deadline) : null)}. Delivery takes about {swap.quote.timeEstimate} s after your deposit confirms.</p>
        <p className={`swap-status ${status === "SUCCESS" ? "ok" : status && FINAL_STATUSES.includes(status) ? "error" : ""}`}>
          {status && !FINAL_STATUSES.includes(status) && <span className="spinner" aria-hidden="true" />}
          {status ? STATUS_TEXT[status] : "Checking the swap"}
        </p>
        {status === "SUCCESS" && (
          <ActionButton primary label={`Unwrap and fund ${formatNear(swap.quote.amountOut)}`} run={async () => {
            const held = BigInt(await rpc.ftBalance(wrap, account));
            const value = held < BigInt(swap.quote.amountOut) ? held : BigInt(swap.quote.amountOut);
            await send(tx.unwrapAndFund(wrap, id, value));
            writeSwap(null);
            setSwap(null);
            onChanged();
            return `Added ${formatNear(value)} to the bounty.`;
          }} />
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { writeSwap(null); setSwap(null); setStatus(null); }}>Start over</button>
      </div>
    );
  }

  return (
    <div className="sponsor-block">
      <h4><Coins /> Fund from another chain</h4>
      <p className="muted small">1Click swaps the token you send into exactly the wNEAR you ask for, delivered to <strong className="break">{account}</strong>. A failed swap is refunded to that account's NEAR Intents balance. 1Click charges 0.25%.</p>
      <div className="row">
        <select className="select" value={asset} onChange={(e) => { setAsset(e.target.value); setQuote(null); }} aria-label="Pay with">
          <option value="">{tokens === null ? "Loading tokens…" : "Pay with…"}</option>
          {tokens?.map((t) => <option key={t.assetId} value={t.assetId}>{t.symbol} on {t.blockchain}</option>)}
        </select>
        <div className="input-suffix"><input className="input" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setQuote(null); }} aria-label="NEAR to add" /><span>NEAR</span></div>
        <ActionButton label="Get a quote" run={async () => {
          const { token, request: dryRequest } = request(true);
          const [registered, response] = await Promise.all([rpc.storageBalance(wrap, account), oneClick.quote(dryRequest)]);
          setQuote({ quote: response.quote, token, registered: registered !== null });
          return "Quote ready.";
        }} />
      </div>
      {quote && (
        <div className="quote">
          <p>About <strong>{quote.quote.amountInFormatted} {quote.token.symbol}</strong> (≈ ${Number(quote.quote.amountInUsd).toFixed(2)}) buys exactly <strong>{quote.quote.amountOutFormatted} wNEAR</strong>.</p>
          {!quote.registered && (
            <div className="sponsor-block subtle">
              <p className="small">{account} is not registered with {wrap} yet, so it cannot receive wNEAR. Register first (0.00125 NEAR, refundable):</p>
              <ActionButton label="Register for wNEAR" run={async () => {
                await send([tx.registerWnear(wrap, account)]);
                setQuote({ ...quote, registered: true });
                return "Registered.";
              }} />
            </div>
          )}
          <ActionButton primary disabled={!quote.registered} label="Get the deposit address" run={async () => {
            const { token, request: liveRequest } = request(false);
            const response = await oneClick.quote(liveRequest);
            if (!response.quote.depositAddress) throw new Error("1Click returned no deposit address");
            const next: PendingSwap = { challenge: id, depositAddress: response.quote.depositAddress, depositMemo: response.quote.depositMemo, quote: response.quote, symbol: token.symbol, blockchain: token.blockchain };
            writeSwap(next);
            setSwap(next);
          }} />
        </div>
      )}
    </div>
  );
}
