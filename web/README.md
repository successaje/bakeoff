# Bakeoff web app

The public face of Bakeoff: a static React app that reads bounties, results and payments straight from NEAR and lets sponsors fund their challenges. Titles, descriptions and baselines come from each sponsor's listing in [`public/challenges.json`](public/challenges.json), and the board says so. It has no backend: NEAR RPC (through FastNEAR), FastFS and the 1Click API all answer browser requests directly.

## Pages

| Page | What it is for |
|---|---|
| Home | **Hero:** a live line naming the latest winner, then "Make your AI work better", its goal word running through cheaper, faster and more accurate before it settles. Under it, a full-width band that charts the latest win: a ridge of ticket tiles, built up blank and then breathing in their colour, under a dashed bar labelled with the real requirements, the winner's peak rising past it and the team's own setup below, with a card cycling through the latest on-chain activity. **Built on:** the logo of each part Bakeoff runs on, with its job in a few words. **Leaderboards:** one card per requirement, each builder's best result next to the team's own setup, with the requirement marked on every bar. **Challenges** as wide cards with their requirements. **Agents:** an agent's session through the MCP tools beside a wall of tiles that light up in turn. **How a bake-off works** as a stepper beside each step's panel, ending on the winning result replayed. **Everything you need to run a bake-off,** over a receipt read from the contracts. **Guides,** and three things nobody can do. |
| Challenges | Every listed challenge as a card, with search and category tiles: open, awarded, coming up and demo rounds. |
| Challenge | A competition page in tabs, with the tab bar pinned under the top bar as you scroll. **Overview:** the problem, the goal against the baseline, how it's tested and a timeline, beside the host, reward, participation and whether the contract is locked. **Data:** the public practice tickets, a field dictionary from the on-chain rules, label charts and a ticket explorer. **Leaderboard:** a podium, then each builder once by their best result, or every result as recorded. **Rules:** the requirements, how the reward is won, what a solution may change, and the in-browser checks. **Take part.** The owner also sees a **Manage** tab. |
| Result | Did it meet each requirement; how it compares with the baseline; the solution's config, to copy or download; the exact request to try it safely; the test's limitations; and the evidence on-chain. |
| For builders | Connecting Claude Code, Codex or any MCP client; the seven tools and what each costs; the safety model. |
| For teams | What a team brings, how the requirements come from its baseline, a challenge's lifecycle, the ways to fund it, and what setting one up takes today. |
| How it works | One submission end to end; what stays hidden and what is public; what you still have to trust; questions. |
| Leaderboard | Builders across every listed challenge, ranked by rewards won, then results that met every requirement. |
| Account | One NEAR account's record: rewards won, every result it submitted, and the challenges it hosts. |
| Demo (`/#/demo`) | A self-playing film of Bakeoff, 2:13, made to be screen-recorded at 1920×1080: the problem, the turn, how a bake-off works, the mainnet result from the chain, and what it could change. Space plays, ←/→ move between scenes, F goes full screen, H hides the controls, and `?scene=<id>&at=<ms>` opens one moment paused. |

`/agents` and `/sponsors`, the guides' earlier addresses, redirect to `/builders` and `/teams`.

## Finding a result's solution

The contract stores only the SHA-256 of each result's config. The result page lists the submitter's transactions to the challenge through [nearblocks](https://nearblocks.io), reads each `submit` transaction's arguments from FastNEAR's archival node, and shows the config only if it hashes to the record. From the config and the rules it rebuilds the chat request the evaluator sent for each ticket, the same way the evaluator does, for the team to download and run beside its current agent.

The challenges listed, with a title, the task and the baseline each sponsor published, are in [`public/challenges.json`](public/challenges.json). Everything else comes from the contracts.

## Design

- **Type.** Geist for text and headings, Geist Mono for hashes and figures, and Instrument Serif italics for the one accent word in a headline. All three are self-hosted.
- **Frame.** A top bar with the destinations, a search button that opens in place of the links (or press `/`), the network and theme controls, and the wallet. Narrow screens move the destinations into a drawer. The footer is a cream band with the wordmark and link columns.
- **Colour.** Tokens in [`src/styles/tokens.css`](src/styles/tokens.css):
  - **Light,** the default: white pages, cream bands, ink pills for the main action, and a deep green that keeps text above 4.5:1 contrast.
  - **Dark:** NEAR's near-black with its green, picked from the theme button or the system's setting.
  - Amber marks money, coral marks failures.
  - The theme is applied before first paint.
- **Generated art.** Every challenge gets a cover and every account an avatar, drawn from a hash of its name. The landing page's ridge and tile wall ([`landing.tsx`](src/components/landing.tsx)) are drawn in code from a fixed seed, and the ridge's labels come from the chain.
- **Motion that shows the product working.** Every animation acts out something Bakeoff does, with real data from the chain:
  - **The hero's card** cycles through what just happened on-chain: rewards paid, results that passed, and the owner's trials.
  - **How a bake-off works** steps through four panels ([`StepPanels`](src/components/StepPanels.tsx)): that challenge's goal, the public practice set beside the sealed one, the sealed run, and the payment. The last ([`EvaluationRun`](src/components/EvaluationRun.tsx)) replays the latest winning result: the hidden tickets scan, the totals settle, each requirement is checked and the payment lands. Only totals leave the enclave, so the squares fill in order and the caption says so.
  - **Results that settle** while a challenge page is open glow once, and a result still scoring shimmers its label.
- **Restraint.** Headings are set light, at weight 450. Entrances rise 10 px over half a second, and interface transitions take 140–200 ms. Everything respects `prefers-reduced-motion`: the steps stop advancing on their own and the replay shows the finished run.
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

The challenges listed for each network are in [`public/challenges.json`](public/challenges.json). The build uses relative paths, so `dist/` can be served from any static host or sub-path.

## Deployment

The board is deployed on Vercel at [bakeoff-near.vercel.app](https://bakeoff-near.vercel.app). The Vercel project builds `web/` from GitHub: every push to `main` deploys to production, and every pull request gets its own preview. The project's root directory is `web`; Vercel detects Vite, runs `npm run build` and serves `dist/`. The board needs no environment variables, since everything it shows is read from NEAR in the browser.

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
