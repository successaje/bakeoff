# Bakeoff web app

The public face of Bakeoff: a static React app that reads every figure straight from NEAR and lets sponsors fund their challenges. It has no backend: NEAR RPC (through FastNEAR), FastFS and the 1Click API all answer browser requests directly.

## Pages

| Page | What it is for |
|---|---|
| Home | **Hero:** the sealed enclave as a 3D glass cube, with the latest real verdict beside it. **Live stats** from the contracts. **How a bake-off works.** **Spotlight:** the latest winner against the baseline. Then the challenges, the two audiences, and why the results can be trusted. |
| Challenges | Every listed challenge, filterable by open, awarded and draft. Each card shows its bounty, a live countdown, its gates and any winner. |
| Challenge | **Header:** the bounty card and the award. **"The bar":** each metric as a gauge, with the sponsor's baseline, the gate and the winner or best pass. **Tabs:** verdicts, in-browser verification, how to compete, and the sponsor's controls. |
| For agents | Connecting Claude Code, Codex or any MCP client; the seven tools and what each costs; the safety model. |
| For sponsors | What a sponsor brings, how the bar is set from their baseline, a challenge's lifecycle, and the ways to fund it. |
| How it works | One submission end to end; what stays private and what is public; questions. |

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

## Checks in the browser

- **Rules.** The page hashes the rules the contract serves and compares them with its commitment.
- **Evaluator.** It downloads the pinned evaluator from FastFS and hashes it.
- **Configs.** Pasting a candidate config finds the evaluations that scored it.

## What a sponsor can do

Connect with [NEAR Connect](https://docs.near.org/web3-apps/tutorials/web-login/near-connector), which offers Meteor, Intear, Ledger, NEAR CLI and other wallets. The page offers each action only while the contract would accept it:

| Action | When |
|---|---|
| Fund from the wallet | Draft, or open before the deadline |
| Open for N hours | Draft |
| Withdraw the bounty | Draft, or after an unwon deadline with nothing pending |
| Retry a failed award payment | Any connected account, when an award is owed |
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
- NEAR amount parsing, refusing anything that is not a plain positive decimal;
- the transactions the page asks a wallet to sign;
- the 1Click quote request;
- the 1Click client against a fake API.

Chain data is always rendered as text, never parsed as HTML, so account names and reasons cannot inject markup.
