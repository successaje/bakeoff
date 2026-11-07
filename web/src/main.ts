import "./style.css";
import { h } from "./dom.ts";
import { sponsorPanel } from "./funding.ts";
import { type ChallengeView, NearRpc, type Network, NETWORKS } from "./near.ts";
import { boardView, challengeView, explorerFor } from "./views.ts";
import { Wallet } from "./wallet.ts";

type Route = { network: Network; challenge: string | null };

function route(): Route {
  const [network, challenge] = location.hash.replace(/^#\/?/, "").split("/");
  return { network: network === "mainnet" ? "mainnet" : "testnet", challenge: challenge || null };
}

const main = document.querySelector("main")!;
const header = document.querySelector("header")!;
let wallet: Wallet | null = null;
let listed: Record<Network, string[]> | null = null;

async function challengeIds(network: Network): Promise<string[]> {
  listed ??= (await (await fetch("./challenges.json")).json()) as Record<Network, string[]>;
  return listed[network] ?? [];
}

function renderHeader(network: Network): void {
  const account = wallet?.account;
  header.replaceChildren(
    h("a", { class: "brand", href: `#/${network}` }, "Bakeoff"),
    h("nav", {},
      ...(["testnet", "mainnet"] as Network[]).map((n) =>
        h("a", { href: `#/${n}`, class: n === network ? "active" : undefined }, n)),
    ),
    account
      ? h("div", { class: "account" }, h("span", { class: "mono" }, account),
        h("button", { type: "button", class: "secondary", onclick: () => void wallet?.signOut() }, "Sign out"))
      : h("button", { type: "button", onclick: () => void wallet?.signIn() }, "Connect wallet"),
  );
}

async function render(): Promise<void> {
  const { network, challenge } = route();
  if (wallet?.network !== network) {
    wallet = new Wallet(network, () => void render());
    renderHeader(network);
    await wallet.restore();
    return;
  }
  renderHeader(network);
  const rpc = new NearRpc(NETWORKS[network].rpc);
  const page = { network, explorer: explorerFor(network) };
  main.replaceChildren(h("p", { class: "muted" }, "Reading the chain…"));
  try {
    if (!challenge) {
      const ids = await challengeIds(network);
      const rows = await Promise.all(ids.map(async (id) => {
        try {
          return { id, view: await rpc.getChallenge(id) };
        } catch (error) {
          return { id, error: (error as Error).message };
        }
      }));
      main.replaceChildren(boardView(page, rows));
      return;
    }
    const view: ChallengeView = await rpc.getChallenge(challenge);
    const evaluations = await rpc.getAllEvaluations(challenge, view.evaluations);
    const sponsor = sponsorPanel({ network, id: challenge, view, rpc, wallet, refresh: () => void render() });
    main.replaceChildren(challengeView(page, challenge, view, evaluations, sponsor));
  } catch (error) {
    main.replaceChildren(h("p", { class: "error" }, `Could not read ${challenge ?? "the challenges"}: ${(error as Error).message}`));
  }
}

window.addEventListener("hashchange", () => void render());
void render();
