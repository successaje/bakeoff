/**
 * NEAR Connect, wrapped to what the pages need: who is signed in, and
 * signing. The connector is loaded on first use, so it stays out of the
 * first page's download.
 */

import type { NearConnector } from "@hot-labs/near-connect";
import type { Network } from "./near.ts";
import type { Transaction } from "./transactions.ts";

export class Wallet {
  readonly network: Network;
  account: string | null = null;
  private readonly onChange: () => void;
  private connector: Promise<NearConnector> | null = null;

  constructor(network: Network, onChange: () => void) {
    this.network = network;
    this.onChange = onChange;
  }

  private load(): Promise<NearConnector> {
    this.connector ??= import("@hot-labs/near-connect").then(({ NearConnector }) => {
      const connector = new NearConnector({ network: this.network, features: { signAndSendTransactions: true } });
      connector.on("wallet:signIn", ({ accounts }) => {
        this.account = accounts[0]?.accountId ?? null;
        this.onChange();
      });
      connector.on("wallet:signOut", () => {
        this.account = null;
        this.onChange();
      });
      return connector;
    });
    return this.connector;
  }

  /** Picks up a wallet the user connected on an earlier visit. */
  async restore(): Promise<void> {
    try {
      const wallet = await (await this.load()).wallet();
      this.account = (await wallet.getAccounts())[0]?.accountId ?? null;
    } catch {
      this.account = null;
    }
    this.onChange();
  }

  async signIn(): Promise<unknown> {
    return (await this.load()).connect();
  }

  async signOut(): Promise<void> {
    return (await this.load()).disconnect();
  }

  /** Signs and sends with one approval, whether one transaction or several. */
  async send(transactions: Transaction[]): Promise<void> {
    const wallet = await (await this.load()).wallet();
    if (transactions.length === 1) {
      await wallet.signAndSendTransaction({ network: this.network, ...transactions[0]! });
    } else {
      await wallet.signAndSendTransactions({ network: this.network, transactions });
    }
  }
}
