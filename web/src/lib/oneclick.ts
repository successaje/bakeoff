/**
 * Cross-chain funding through NEAR Intents' 1Click API. 1Click delivers
 * wNEAR to the sponsor's own NEAR account, from which `unwrapAndFund` moves
 * it into the bounty. Mainnet only: NEAR Intents has no testnet.
 */

export const ONECLICK_API = "https://1click.chaindefuser.com";
export const WNEAR_ASSET = "nep141:wrap.near";

export interface Token {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  contractAddress?: string;
}

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_OUTPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
  referral: string;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  amountOut: string;
  amountOutFormatted: string;
  deadline?: string;
  timeEstimate: number;
}

export interface QuoteResponse {
  quote: Quote;
  quoteRequest: QuoteRequest;
  signature: string;
  timestamp: string;
}

export type SwapStatus =
  | "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS"
  | "INCOMPLETE_DEPOSIT" | "REFUNDED" | "FAILED";

export interface StatusResponse {
  status: SwapStatus;
  swapDetails: { amountOut?: string; refundReason?: string; destinationChainTxHashes?: { hash: string }[] };
}

export const FINAL_STATUSES: SwapStatus[] = ["SUCCESS", "INCOMPLETE_DEPOSIT", "REFUNDED", "FAILED"];

/**
 * Asks for exactly `amountYocto` wNEAR at `recipient`. Refunds go to the
 * same account's NEAR Intents balance, so no origin-chain address is needed.
 */
export function quoteRequest(options: {
  originAsset: string;
  amountYocto: bigint;
  recipient: string;
  dry: boolean;
  now?: number;
}): QuoteRequest {
  return {
    dry: options.dry,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: options.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: WNEAR_ASSET,
    amount: String(options.amountYocto),
    refundTo: options.recipient,
    refundType: "INTENTS",
    recipient: options.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date((options.now ?? Date.now()) + 60 * 60 * 1000).toISOString(),
    referral: "bakeoff",
  };
}

export class OneClick {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch.bind(globalThis)) {
    this.fetchImpl = fetchImpl;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${ONECLICK_API}${path}`, init);
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) throw new Error(`1Click: ${body.message ?? `HTTP ${response.status}`}`);
    return body;
  }

  /** Tokens 1Click can swap from, without wNEAR itself. */
  async tokens(): Promise<Token[]> {
    const all = await this.json<Token[]>("/v0/tokens");
    return all
      .filter((t) => t.assetId !== WNEAR_ASSET && t.price > 0)
      .sort((a, b) => a.blockchain.localeCompare(b.blockchain) || a.symbol.localeCompare(b.symbol));
  }

  quote(request: QuoteRequest): Promise<QuoteResponse> {
    return this.json("/v0/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
    const query = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
    return this.json(`/v0/status?${query}`);
  }
}
