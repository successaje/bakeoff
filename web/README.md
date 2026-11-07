# Bakeoff web board

A static page that reads Bakeoff challenges straight from NEAR and lets their sponsors fund them. It has no backend: NEAR RPC, FastFS and the 1Click API all answer browser requests directly.

## What it shows

- **The board:** every listed challenge with its status, bounty, deadline and gates.
- **A challenge:**
  - the award and who won it;
  - every verdict with its accuracy, cost per ticket, p95 latency, leaks and invalid answers;
  - which submissions were the owner's trial runs;
  - how to compete through the [MCP server](../mcp/README.md).
- **Checks in the browser:**
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
