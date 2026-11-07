/** NEAR Connect, wrapped to what the page needs: who is signed in, and signing. */

import { NearConnector } from "@hot-labs/near-connect";
import type { Network } from "./near.ts";
import type { Transaction } from "./transactions.ts";

export class Wallet {
  readonly network: Network;
  account: string | null = null;
  private readonly connector: NearConnector;
  private readonly onChange: () => void;

  constructor(network: Network, onChange: () => void) {
    this.network = network;
    this.onChange = onChange;
    this.connector = new NearConnector({ network, features: { signAndSendTransactions: true } });
    this.connector.on("wallet:signIn", ({ accounts }) => {
      this.account = accounts[0]?.accountId ?? null;
      this.onChange();
    });
    this.connector.on("wallet:signOut", () => {
      this.account = null;
      this.onChange();
    });
  }

  /** Picks up a wallet the user connected on an earlier visit. */
  async restore(): Promise<void> {
    try {
      const wallet = await this.connector.wallet();
      this.account = (await wallet.getAccounts())[0]?.accountId ?? null;
    } catch {
      this.account = null;
    }
    this.onChange();
  }

  signIn(): Promise<unknown> {
    return this.connector.connect();
  }

  signOut(): Promise<void> {
    return this.connector.disconnect();
  }

  /** Signs and sends with one approval, whether one transaction or several. */
  async send(transactions: Transaction[]): Promise<void> {
    const wallet = await this.connector.wallet();
    if (transactions.length === 1) {
      await wallet.signAndSendTransaction({ network: this.network, ...transactions[0]! });
    } else {
      await wallet.signAndSendTransactions({ network: this.network, transactions });
    }
  }
}
