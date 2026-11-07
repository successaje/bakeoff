/** The selected network and the connected wallet, shared by every page. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Network } from "./near.ts";
import type { Transaction } from "./transactions.ts";
import { Wallet } from "./wallet.ts";

interface Session {
  network: Network;
  setNetwork: (network: Network) => void;
  account: string | null;
  walletReady: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  send: (transactions: Transaction[]) => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);
const KEY = "bakeoff:network";

/** Mainnet unless the visitor picked testnet. */
function storedNetwork(): Network {
  try {
    return localStorage.getItem(KEY) === "testnet" ? "testnet" : "mainnet";
  } catch {
    return "mainnet";
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [network, setNetworkState] = useState<Network>(storedNetwork);
  const [account, setAccount] = useState<string | null>(null);
  const [walletReady, setWalletReady] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);

  useEffect(() => {
    const created = new Wallet(network, () => setAccount(created.account));
    setWallet(created);
    setAccount(null);
    setWalletReady(false);
    void created.restore().finally(() => setWalletReady(true));
  }, [network]);

  const setNetwork = useCallback((next: Network) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Applies for this visit only.
    }
    setNetworkState(next);
  }, []);

  const value = useMemo<Session>(() => ({
    network,
    setNetwork,
    account,
    walletReady,
    signIn: async () => {
      await wallet?.signIn();
    },
    signOut: async () => {
      await wallet?.signOut();
    },
    send: async (transactions) => {
      if (!wallet) throw new Error("the wallet is still loading");
      await wallet.send(transactions);
    },
  }), [network, setNetwork, account, walletReady, wallet]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside SessionProvider");
  return session;
}
