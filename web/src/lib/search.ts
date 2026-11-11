/** The header's search: challenges by title, host or account, and builder accounts. */

import type { Network } from "./near.ts";
import type { Registry } from "./registry.ts";

export interface SearchItem {
  kind: "challenge" | "account";
  /** Where the result leads. */
  to: string;
  title: string;
  detail: string;
  network: Network;
  /** Lower-cased text the query is matched against. */
  text: string;
}

export function challengeItems(registry: Registry): SearchItem[] {
  return (Object.entries(registry) as [Network, Registry[Network]][]).flatMap(([network, list]) =>
    list.map((c) => ({ kind: "challenge" as const, to: `/challenges/${c.id}`, title: c.title, detail: `${c.sponsor} · ${network}`, network, text: `${c.title} ${c.sponsor} ${c.id}`.toLowerCase() })),
  );
}

export function accountItems(accounts: string[], network: Network): SearchItem[] {
  return [...new Set(accounts)].map((id) => ({ kind: "account" as const, to: `/accounts/${id}`, title: id, detail: `Builder · ${network}`, network, text: id.toLowerCase() }));
}

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+\.(near|testnet)$/;

/**
 * Items matching every word of the query: whole-title starts first, then
 * word starts, then anywhere. A full account name that matches nothing still
 * gets a result, since any account can be looked up on the chain.
 */
export function search(items: SearchItem[], query: string, limit = 8): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const score = (item: SearchItem) => {
    if (!words.every((w) => item.text.includes(w))) return -1;
    if (item.title.toLowerCase().startsWith(q)) return 3;
    if (item.text.split(/[\s.\-_]+/).some((part) => part.startsWith(words[0]!))) return 2;
    return 1;
  };
  const found = items.map((item) => ({ item, s: score(item) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.item.title.localeCompare(b.item.title)).map((x) => x.item);
  if (ACCOUNT.test(q) && !found.some((item) => item.kind === "account" && item.title === q)) {
    found.push({ kind: "account", to: `/accounts/${q}`, title: q, detail: "Look up this account", network: q.endsWith(".testnet") ? "testnet" : "mainnet", text: q });
  }
  return found.slice(0, limit);
}
