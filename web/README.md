# Bakeoff web app

The public face of Bakeoff: a static React app that reads bounties, results and payments straight from NEAR and lets sponsors fund their challenges. Titles, descriptions and baselines come from each sponsor's listing in [`public/challenges.json`](public/challenges.json), and the board says so. It has no backend: NEAR RPC (through FastNEAR), FastFS and the 1Click API all answer browser requests directly.

## Pages

| Page | What it is for |
|---|---|
| Home | **Hero:** "Make your AI work better", with *Explore challenges* and *Set up a challenge*, the enclave as a 3D glass cube, and the latest real result beside it. **Live stats** from the contracts. **How a bake-off works.** **From goal to result:** the latest winner against the baseline, linking to its result. Then the challenges, the two audiences, and what can be checked. |
| Challenges | Every listed challenge, filterable by open, awarded and draft. Each card shows its reward, a live countdown, its requirements and any winner. |
| Challenge | A story in sections, with a bar to jump between them. **Header:** the reward card and one action: see the winning result, take part, or see the results. **The problem** in the owner's words and figures. **The goal** as one sentence, and each requirement as a gauge against the baseline and the best result. **How it's tested:** what builders can see and what stays hidden. **Results**, each opening its own page. **Take part** and **Rules and verification.** The owner also sees a **Manage** section. |
| Result | Did it meet each requirement; how it compares with the baseline; the solution's config, to copy or download; the exact request to try it safely; the test's limitations; and the evidence on-chain. |
| For builders | Connecting Claude Code, Codex or any MCP client; the seven tools and what each costs; the safety model. |
| For teams | What a team brings, how the requirements come from its baseline, a challenge's lifecycle, the ways to fund it, and what setting one up takes today. |
| How it works | One submission end to end; what stays hidden and what is public; what you still have to trust; questions. |

`/agents` and `/sponsors`, the guides' earlier addresses, redirect to `/builders` and `/teams`.

## Finding a result's solution

The contract stores only the SHA-256 of each result's config. The result page lists the submitter's transactions to the challenge through [nearblocks](https://nearblocks.io), reads each `submit` transaction's arguments from FastNEAR's archival node, and shows the config only if it hashes to the record. From the config and the rules it rebuilds the chat request the evaluator sent for each ticket, the same way the evaluator does, for the team to download and run beside its current agent.

The challenges listed, with a title, the task and the baseline each sponsor published, are in [`public/challenges.json`](public/challenges.json). Everything else comes from the contracts.

## Design

- **Type.** Geist for text and headings, Geist Mono for hashes and figures, and Instrument Serif italics for the one accent word in a headline. All three are self-hosted.
- **Colour.** Tokens in [`src/styles/tokens.css`](src/styles/tokens.css):
  - **Dark:** NEAR's near-black with its green.
  - **Light:** a warm off-white with a deeper green that keeps text above 4.5:1 contrast.
  - Amber marks money, coral marks failures.
  - The theme follows the system until the visitor picks one, and is applied before first paint.
- **3D.** [`HeroScene`](src/components/HeroScene.tsx) is one ray-marched WebGL2 fragment shader with no 3D library:
  - It draws a rounded glass cube over a perspective grid, with the three gates passing through it.
  - It reads its colours from the theme, renders at most 1.5× resolution, and pauses off-screen.
  - Under reduced motion it draws one frame. Without WebGL2 it falls back to a gradient.
- **Motion.** Pages animate in on arrival, and sections and figures as they scroll into view; tabs and switches slide between options. Everything respects `prefers-reduced-motion`.
- **Loading.** Only the home page and the shared shell load up front. Other pages and the wallet connector load on first use.

## Trust and status

- **Demo rounds** carry a Demo badge and a notice saying which parts are real. A listing marks itself as a demo with `"demo": true`.
- **Awarded and paid** are separate states. Cards say Awarded until the payment lands, and the challenge page explains an unpaid award and how to retry it.
- **Freshness.** The challenge page shows when it last read the chain and has a Refresh button. While a result is scoring, it re-reads every 10 s.
- **Sources.** The footer, each challenge's problem and goal sections, and each result say which figures come from the contract and which from the owner's listing. The How it works page lists what users still have to trust.

## Checks in the browser

- **Rules.** The page hashes the rules the contract serves and compares them with its commitment.
- **Evaluator.** It downloads the pinned evaluator from FastFS and hashes it. A download that fails says Could not verify, not Mismatch.
- **Configs.** Pasting a candidate config finds the evaluations that scored it.

## What the owner can do

Connect with [NEAR Connect](https://docs.near.org/web3-apps/tutorials/web-login/near-connector), which offers Meteor, Intear, Ledger, NEAR CLI and other wallets. The challenge page then shows a Manage section to the owner only, and offers each action only while the contract would accept it:

| Action | When |
|---|---|
| Add to the reward from the wallet | Draft, or open before the deadline |
| Open for N hours | Draft |
| Withdraw the reward | Draft, or after an unwon deadline with nothing pending |
| Retry a failed award payment | Any connected account, from the notice on the challenge or result page |
| Add wNEAR you hold | One approval unwraps it and funds the bounty |
| Fund from another chain | Mainnet: see below |

### Funding from another chain

[NEAR Intents' 1Click API](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api) swaps any of about 200 tokens on about 40 chains into wNEAR. Four steps:

1. **Quote.** Pick the token and the amount of NEAR to add. The page gets a quote and shows what to send.
2. **Register (if needed).** If your account is not yet registered with `wrap.near`, register it first (0.00125 NEAR).
3. **Deposit.** The page gets a deposit address and tracks the swap until 1Click reports it delivered.
4. **Fund.** One wallet approval unwraps the delivered wNEAR and calls `fund`.

The swap delivers to your own NEAR account, not to the contract:
- the contract only accepts bounty money from its owner, so a refund can only go back to where the bounty came from;
- 1Click's option to deliver straight into a contract is marked experimental and can lose funds.

If a swap fails, 1Click refunds to your account's NEAR Intents balance. Without a partner key 1Click adds a 0.25% fee.

NEAR Intents has no testnet, so cross-chain funding works on mainnet only. On testnet, use the wallet and wNEAR paths, from `wrap.testnet`.

## Run it

```bash
npm ci
npm run dev        # http://localhost:5173
npm run build      # static files in dist/
```

The challenges listed for each network are in [`public/challenges.json`](public/challenges.json). The build uses relative paths, so `dist/` can be served from any static host or sub-path. The [Pages workflow](../.github/workflows/pages.yml) publishes it to GitHub Pages when run.

## Development

```bash
npm run typecheck
npm test
```

The tests cover:
- finding a result's config from its transaction, and refusing one that does not hash to the record;
- rebuilding the evaluator's chat request, and checking requirements and the baseline comparison;
- NEAR amount parsing, refusing anything that is not a plain positive decimal;
- the transactions the page asks a wallet to sign;
- the 1Click quote request;
- the 1Click client against a fake API.

Chain data is always rendered as text, never parsed as HTML, so account names and reasons cannot inject markup.
