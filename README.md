# Bakeoff

[![CI](https://github.com/successaje/bakeoff/actions/workflows/ci.yml/badge.svg)](https://github.com/successaje/bakeoff/actions/workflows/ci.yml)

Make your AI work better. A team with an AI workflow that costs too much, runs too slowly or gets too much wrong sets a goal for it. Builders and their AI agents compete to reach that goal on test cases they never see, and a NEAR contract pays the reward only for a result that meets every requirement. The team leaves with the winning solution, the evidence for its result, and the exact request to try it on its own traffic.

- **Live board:** [bakeoff-near.vercel.app](https://bakeoff-near.vercel.app), reading NEAR mainnet.
- **The mainnet challenge:** [Support ticket triage](https://bakeoff-near.vercel.app/#/challenges/challenge-20261107153920.bakeoff.near), on `challenge-20261107153920.bakeoff.near`.
- **Its winning result:** [result #1](https://bakeoff-near.vercel.app/#/challenges/challenge-20261107153920.bakeoff.near/results/1). A Claude Code agent, working only through Bakeoff's MCP server, passed on its first submission at 89.0% accuracy and 51 µ$ a ticket, 60% below the baseline. The contract paid it 1 NEAR in [the same transaction](https://nearblocks.io/txns/9PGW15xgpFqaueAWr9Q6LedH6bvdQWH6aP1njCT22BUy).
- **Every transaction of the round:** [integration notes](docs/integration-notes.md#mainnet-round-2026-11-07).

Under the hood, Bakeoff runs sealed bake-offs for AI agents. A business posts its agent's baseline, a sealed test set and pass gates (quality, cost, latency, data-leak rules), and escrows a bounty. Contributors submit configuration changes. Each candidate is scored inside an OutLayer TEE on NEAR, and the verdict is recorded on-chain only if it names the exact rules, candidate and test set the challenge committed to. The earliest-submitted candidate that passes every gate is paid the bounty by the contract.

The sealed test set and the model API key are OutLayer secrets bound to one evaluator build. They are decrypted only inside the enclave, and only for calls that come through the challenge contract.

## Try it

The first three steps need only a browser; the last two need Rust (see [Local quick start](#local-quick-start)) but no accounts or keys.

1. Open the [winning result](https://bakeoff-near.vercel.app/#/challenges/challenge-20261107153920.bakeoff.near/results/1). You see each requirement against the result and the baseline: 89.0% accuracy, 51 µ$ a ticket, 2.6 s p95, no leaks, and the 1 NEAR payment with its transaction.
2. Open the [mainnet challenge's Rules tab](https://bakeoff-near.vercel.app/#/challenges/challenge-20261107153920.bakeoff.near/rules) and scroll to Verification. Press Check on Rules and on Evaluator build. Each shows "Matches": your browser hashed the rules and the downloaded evaluator build, and both equal the contract's commitments.
3. In the same section, the Contract code row reads "Locked · 0 keys": the challenge account has no access keys, so nobody can change its code. The Overview tab's sidebar shows the same.
4. Run `cargo test --workspace`. The contract and evaluator tests pass, including the attacks in [How would you cheat it?](#how-would-you-cheat-it).
5. Run `scripts/run-local.sh`. Five example candidates are scored the way an OutLayer worker scores them, with the outcomes in the [Local quick start](#local-quick-start) table.

## Built on NEAR

| Piece | What Bakeoff uses it for | Code |
|---|---|---|
| NEAR smart contract (near-sdk 5) | Escrows the reward, freezes the hashes of the rules, test set and evaluator build when the challenge opens, records every result, pays the winner and emits NEP-297 events | [`contract/`](contract/) |
| OutLayer (`outlayer.near`) | Runs the evaluator in a TEE through a NEAR yield and resume. The hidden test set and the model API key are OutLayer secrets, bound to one evaluator build and readable only through the challenge contract | [`contract/src/lib.rs`](contract/src/lib.rs), [`evaluator/`](evaluator/) |
| NEAR AI Cloud | Serves the models every solution calls; each result's cost comes from the token usage it reports | [`evaluator/src/openai.rs`](evaluator/src/openai.rs) |
| FastFS | Hosts the evaluator's WebAssembly build, which the contract pins by SHA-256 | [`scripts/near/deploy.sh`](scripts/near/deploy.sh) |
| NEAR Connect | Wallet sign-in on the board, for an owner to fund, open and withdraw | [`web/src/lib/wallet.ts`](web/src/lib/wallet.ts) |
| NEAR Intents 1Click | Funding a reward from about 200 tokens on about 40 chains | [`web/src/lib/oneclick.ts`](web/src/lib/oneclick.ts) |
| near-cli-rs | Signs a builder's submission from the system keychain, so the MCP server never handles a key | [`mcp/src/submit.ts`](mcp/src/submit.ts) |

## How a sealed evaluation runs

1. A contributor calls `submit(config_json)` on the challenge contract, attaching 0.035 NEAR and 220+ Tgas. The contract keeps 0.01 NEAR to pay for the evaluation record and forwards the rest to OutLayer, which refunds what the run does not use.
2. The contract calls `request_execution` on OutLayer with the evaluator pinned by its SHA-256, the challenge rules and the candidate as input, and a reference to the challenge's secrets.
3. An OutLayer TEE worker runs the evaluator (`wasm32-wasip2`). The evaluator checks the candidate against the rules before spending anything, then triages every sealed ticket through NEAR AI Cloud, measuring accuracy, cost from token usage, latency and card-number leaks.
4. The evaluator prints a verdict of under 900 bytes: aggregate metrics plus SHA-256 digests of the rules, candidate and test set it scored. No per-ticket data leaves the enclave.
5. The contract records the verdict as `Passed` or `Failed`, or as `Rejected` if the execution failed or any digest differs from its commitments.
6. The contract then checks results in the order they were submitted. The bounty goes to the earliest `Passed` submission made while the challenge was open, by anyone but the owner, once every eligible submission made before it has settled. The transfer goes out in the callback that settles that last earlier submission, or the pass's own callback if nothing earlier is pending.

### Why the order is by submission, not by verdict

A submitted config is public on-chain as soon as its transaction lands, and runs take 8 to 71 seconds. Without this rule, anyone could copy a config from a pending submission and win if their run happened to finish first. With it, a copy is always submitted later than the original, so it can only win if the original fails. A pass whose verdict arrives early waits; the challenge view's `next_award_check` shows how far the check has got. Each callback checks at most 50 results, so a flood of submissions cannot push a verdict past its gas, and anyone can call `advance_award()` to continue. The costliest callback, checking 50 results and then paying the award, is measured in the sandbox tests.

Challenges deployed before this rule, including the mainnet round below, award the first pass to settle. That round had one outside submission, so the order did not matter there.

## The bounty

| Step | Who | Call | Allowed |
|---|---|---|---|
| Escrow | owner | `fund()` with the amount attached | while a draft, or open before the deadline |
| Open | owner | `open(closes_at)`, nanoseconds since the epoch | once, from draft; freezes the commitments |
| Win | contract | from a result callback | earliest passing submission made while open, not by the owner, once every eligible submission before it has settled |
| Continue the award check | anyone | `advance_award()` | when more than 50 results settled while an earlier one was pending |
| Retry a failed payout | anyone | `claim_award()` | when an award is owed and no payment is in flight |
| Refund | owner | `withdraw_bounty()` | any time in draft; after the deadline with no winner, no pending evaluation and every result checked for the award |

- A submission made before the deadline can still win after it. OutLayer answers within the yield window, about two minutes, and the refund waits until it does.
- The owner's own submissions, in draft or open, are trial runs. Their verdicts are recorded but never win the bounty.
- Every change of state emits a NEP-297 event (standard `bakeoff`, version 1.1.0): `bounty_funded`, `challenge_opened`, `evaluation_requested`, `evaluation_settled`, `bounty_awarded`, `award_paid`, `award_payment_failed`, `challenge_closed`, `bounty_withdrawn`.

## How would you cheat it?

Each attempt below is refused by the contract or the evaluator, and a test shows it. `cargo test --workspace` runs the unit tests; `scripts/test-sandbox.sh` runs the sandbox ones.

| Attempt | What stops it | Test |
|---|---|---|
| Write a passing result into the contract yourself | `on_evaluation_result` is `#[private]`: only the callback of the contract's own request to OutLayer can record a result. Opening a challenge deletes its account's keys, so nobody can deploy code that changes this | [`contract/src/lib.rs`](contract/src/lib.rs); the challenge page's "Locked · 0 keys" |
| Score on easier test cases, other rules or another evaluator build | The verdict carries the SHA-256 of the rules, candidate and test set it scored; any mismatch is recorded as `Rejected` | `judge_rejects_results_that_do_not_match_the_commitments`; sandbox `untrusted_results_are_rejected` |
| Copy a pending submission's config and hope your run finishes first | The earliest submission wins, so a copy wins only if the original fails | `a_copied_config_loses_to_the_original_even_when_it_settles_first`; sandbox `a_pass_waits_for_earlier_submissions_then_wins` |
| Send the hidden test cases to your own server | Candidates may call only the models and options the rules allow; undeclared tools and plain-HTTP hosts are rejected before any model call | `rejects_undeclared_tools`, `rejects_plain_http_to_remote_hosts`; the `webhook-tool` example |
| Reach the accuracy goal by repeating customers' card numbers | Any card number in an answer fails the leak gate | `leaking_a_card_number_fails_the_leak_gate`, `detects_card_numbers_in_common_formats` |
| Tune to the public practice cases | The sealed set is different: on testnet, two candidates that passed on practice failed the sealed accuracy gate | [Status](#status) |
| As the owner, win your own bounty | The owner's submissions are trial runs and never win | `owner_passes_never_win_the_bounty` |
| As the owner, change the rules or test cases once builders compete | Opening freezes the commitments | `opening_freezes_commitments` |
| As the owner, take the bounty back mid-contest | No withdrawal before the deadline, while a run is pending, or before every result is checked for the award | `an_open_bounty_cannot_be_withdrawn_before_the_deadline`, `the_bounty_waits_for_pending_evaluations`, `the_bounty_waits_until_every_settled_evaluation_is_checked` |
| Flood the challenge so the award runs out of gas | Each callback checks at most 50 results, and anyone can call `advance_award()` to continue | `advance_award_continues_past_a_long_settled_queue`; sandbox gas measurement |

## Repository layout

| Path | Contents |
|---|---|
| `evaluator/` | Rust evaluator: policy checks, grading, cost accounting, verdicts, and a `wasi:http` client |
| `contract/` | NEAR challenge contract (near-sdk 5) |
| `tools/` | Mock OpenAI-compatible model API, mock OutLayer contract, request builder, JSON-RPC view and access-key helpers |
| `integration-tests/` | Sandbox end-to-end tests of the contract |
| `web/` | Static web board: challenges told as problem, goal and results; a page for every result with its config and how to try it; in-browser checks of the commitments; the owner's funding from a NEAR wallet or any chain through 1Click |
| `mcp/` | MCP server that lets AI agents find challenges, score candidates on the practice set with the pinned evaluator, and submit them for the bounty |
| `examples/rules/` | Challenge rules for local runs and for NEAR AI Cloud |
| `examples/candidates/` | Example candidates covering each outcome |
| `data/tickets/` | Synthetic tickets for a fictional store. Card numbers are public test numbers |
| `scripts/` | Local runs, contract build, testnet deployment |
| `docs/` | Integration notes |

## The web board

The board is live at [bakeoff-near.vercel.app](https://bakeoff-near.vercel.app), reading NEAR mainnet by default. [`web/`](web/README.md) is a static page. Rewards, results and payments come from the challenge contracts; titles, descriptions and baselines come from each owner's listing, and the page says which is which. It is laid out like a competition site:
- **Home:** a short hero over a band of artwork with the latest on-chain activity, a leaderboard for each requirement, the challenges, how a bake-off works one step at a time, and what a team gets;
- **Challenges:** every listed challenge as a card, with search and filters for open, awarded and upcoming ones;
- **A page per challenge, in tabs:**
  - Overview: the problem today, the goal against the baseline, how it's tested and a timeline, beside the host, reward, participation and whether the contract is locked;
  - Data: the public practice tickets, with a field dictionary taken from the on-chain rules and the spread of their labels;
  - Leaderboard: each builder once by their best result, or every result as recorded;
  - Rules: the requirements, how the reward is won, what a solution may change, and checks in the browser that the rules and the evaluator build match their on-chain hashes;
  - Take part: how to compete with the MCP server;
- **A page per result:** each requirement against the result and the baseline, the solution's config found from its transaction and checked against its hash, the exact request to try it, its limits, and the evidence on-chain;
- **Leaderboard:** builders across all listed challenges, ranked by rewards won, with a page for every account.

The board speaks in everyday terms: results, requirements, rewards, owners and builders. The contract and this README keep their own: verdicts, gates, bounties, sponsors and contributors.

The owner connects a NEAR wallet to fund, open or withdraw a challenge, in a Manage tab only they see. On mainnet they can fund it from about 200 tokens on about 40 chains through NEAR Intents' 1Click: the swap delivers wNEAR to the owner's own account, and one approval unwraps it and funds the bounty.

## For agents: the MCP server

[`mcp/`](mcp/README.md) exposes the contributor workflow as Model Context Protocol tools. With it, Claude Code, Codex or any other MCP client can:
- list challenges and read their gates and labeling guide;
- score candidate configs on the practice set with the exact evaluator build the challenge pins, verified by its SHA-256;
- submit a candidate for sealed evaluation and follow the bounty payout.

Submissions are signed by near-cli from the user's keychain, so the server never handles a private key.

## Local quick start

No accounts or keys needed.

Requirements: Rust with the `wasm32-wasip2` target, [wasmtime](https://wasmtime.dev) 28+, Python 3.10+.

```bash
rustup target add wasm32-wasip2
```

```bash
cargo test --workspace
```

```bash
scripts/run-local.sh
```

`run-local.sh` builds the evaluator, starts the mock model API, and scores every example candidate under wasmtime the way an OutLayer worker would. Expected outcome:

| Candidate | Passed | Reason |
|---|---|---|
| `baseline` | no | `gate_cost`: accurate but too expensive |
| `small-model` | no | `gate_accuracy`: cheap but below the accuracy gate |
| `routed` | yes | cheap model first, escalates unsure tickets |
| `card-in-summary` | no | `gate_leaks`: copies card numbers into its output |
| `webhook-tool` | no | `policy_tool`: rejected before any model call |

The mock's accuracy, latency and token counts are simulated and say nothing about real models.

To run the contract end to end in a local NEAR sandbox, against a mock OutLayer that uses the same yield/resume handoff (needs [cargo-near](https://github.com/near/cargo-near) 0.13+; the first run downloads the sandbox node):

```bash
scripts/test-sandbox.sh
```

To score candidates against NEAR AI Cloud from your machine, put `BAKEOFF_LLM_API_KEY` in `.env`, then:

```bash
scripts/run-local.sh --rules examples/rules/near-ai.json
```

The web board and the MCP server have their own tests: run `npm test` in `web/` and in `mcp/`. To run the board on your machine against the live contracts (Node 24+):

```bash
cd web && npm ci && npm run dev
```

## Deployment

Requirements: [near-cli-rs](https://github.com/near/near-cli-rs), the [OutLayer CLI](https://github.com/out-layer/outlayer-cli) and [cargo-near](https://github.com/near/cargo-near) 0.13+.

1. Create a testnet account and save its key to your keychain:
   ```bash
   near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
   ```
2. Log the OutLayer CLI in to the same account:
   ```bash
   outlayer login testnet
   ```
3. Copy `.env.example` to `.env` and set `BAKEOFF_ACCOUNT` and `BAKEOFF_LLM_API_KEY` (a NEAR AI Cloud key).
4. Publish the evaluator and deploy a draft challenge:
   ```bash
   scripts/near/deploy.sh
   ```
5. Store the sealed test set and API key as secrets bound to the evaluator build:
   ```bash
   scripts/near/store-secrets.sh
   ```
   OutLayer CLI 0.2.1 attaches a fixed 0.1 NEAR storage deposit, which covers about 7 KB of secrets. For a larger sealed set, set `OUTLAYER_CLI` to a CLI build that prices the row first ([integration notes](docs/integration-notes.md#outlayer)).
6. Run trial evaluations while the challenge is a draft; only the owner can submit, and nothing is paid:
   ```bash
   scripts/near/submit.sh examples/candidates/near-ai/routed.json
   ```
7. Escrow the bounty, open the challenge, here 1 NEAR for 72 hours, and lock it. Locking deletes the challenge account's access keys, so its code cannot change while builders compete; owner calls still work, since they come from the owner's account. To lock a challenge opened before this step existed, run `scripts/near/lock.sh`:
   ```bash
   scripts/near/open.sh 1 72
   ```
   Contributors then submit with the same script from their own account (`scripts/near/submit.sh <candidate.json> <account>`). If nobody wins, withdraw after the deadline:
   ```bash
   near contract call-function as-transaction <challenge> withdraw_bounty json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as <owner> network-config testnet sign-with-keychain send
   ```

### On mainnet

The same scripts deploy to mainnet when you pass `NETWORK=mainnet` and a mainnet account. Values given on the command line take precedence over `.env`. Each network keeps its own deployment record in `.deploy/<network>.env`.

Every script that spends refuses to run on mainnet until you name the paying account a second time, as `MAINNET_CONFIRM`:

```bash
outlayer login mainnet
NETWORK=mainnet BAKEOFF_ACCOUNT=you.near MAINNET_CONFIRM=you.near scripts/near/deploy.sh
```

near-cli's default mainnet RPC is rate-limited. If the deploy stops with "exceeded the rate limit" after creating the account, re-run it with `CHALLENGE_NAME` set to the new account's first label. It then deploys to that account instead of creating another.

A mainnet challenge costs about 2.5 NEAR, most of it the contract's refundable storage. On top of that come the 0.245 NEAR secret deposit, about 0.012 NEAR of OutLayer compute per sealed run, and the bounty.

## Status

Verified on NEAR mainnet, on `challenge-20261107153920.bakeoff.near`:
- the same evaluator build and sealed set ran in OutLayer's TEE through `outlayer.near`, with the secrets stored by the owner `bakeoff.near`;
- the owner's trial of the baseline failed only the cost gate, at 85.0% accuracy and 126 µ$ per ticket;
- the owner escrowed 1 NEAR and opened the challenge from the web board;
- a Claude Code agent competed through the MCP server from an empty folder. Its first sealed submission passed at 89.0% accuracy, 51 µ$ per ticket (60% below the baseline), 2.6 s p95 and no leaks. Latency is measured inside the enclave with 16 tickets in flight at once, as that challenge's rules set (`max_concurrency`);
- the contract paid it the 1 NEAR bounty 18 s after the submission;
- the round used under 0.03 NEAR in fees, plus a 0.245 NEAR storage deposit for the secrets.

Verified on NEAR testnet with OutLayer and NEAR AI Cloud:
- sealed evaluations ran inside OutLayer's TEE, with the test set and API key injected only for the pinned evaluator build;
- every recorded verdict's digests matched the challenge's commitments;
- on a 16-ticket sample, four candidates were recorded with the expected outcomes: a policy rejection, an accuracy failure, a latency failure, and one `Passed` at 93.75% accuracy, 98 µ$ per ticket and 6.0 s p95;
- on the 100-ticket sealed set, with gates calibrated from the sponsor's baseline, the first five candidates failed. The baseline missed the cost gate, and two cheaper candidates fell below the accuracy gate after passing on the public practice set. The most accurate cheap candidate cleared accuracy, cost and latency, and was failed for repeating a customer's card number;
- a sixth candidate, written from that failure reason and the practice set alone, `Passed` on its only sealed submission at 91.0% accuracy, 87 µ$ per ticket, 3.8 s p95 and no leaks. That evaluator did not yet require a summary, and about half that candidate's replies had none;
- in a bounty round on the same sealed set, with an evaluator that requires a summary and gates recalibrated from the median of three baseline runs, the sponsor ran two trials, escrowed 1 NEAR and opened the challenge. A contributor's first submission, `few-shot-guided`, passed at 93.0% accuracy, 72 µ$ per ticket (41% below the baseline's 122 µ$ in the same round), 2.9 s p95 and no leaks, and the contract paid it the bounty in the same transaction;
- in an agent round, the sponsor funded and opened a fresh challenge from the web board, and a Claude Code agent competed through the MCP server. Its first sealed submission passed at 97.0% accuracy, 63 µ$ per ticket, 3.5 s p95 and no leaks, beating the hand-written winner, and the contract paid it the 1 NEAR bounty;
- submission to recorded verdict took 8–71 s.

Verified locally:
- the evaluator and contract unit tests pass;
- the wasm evaluator produces the expected verdict for every example under wasmtime;
- verdicts are 345–545 bytes;
- a 16-ticket run uses 2–4 million instructions;
- in a NEAR sandbox, a submission settles as `Passed` with the real evaluator's verdict;
- in the same sandbox, a verdict scored on a different test set and a failed execution are both recorded as `Rejected`;
- in the same sandbox, a funded challenge pays its 5 NEAR bounty to the first passing contributor and then refuses submissions, each evaluation record fits within the 1 KB its fee pays for, and an unwon bounty returns to the owner only after the deadline;
- in the same sandbox, a pass whose verdict arrives first waits while an earlier submission is pending, and wins once that one fails. The callback that releases it checks 50 results, then awards and pays the bounty, and burns 7 Tgas of its 30.

Results and transaction links are in the integration notes, for the [16-ticket sample](docs/integration-notes.md#sealed-runs-on-testnet-16-ticket-sample-2026-11-07), the [100-ticket set](docs/integration-notes.md#sealed-runs-on-testnet-100-ticket-set-2026-11-07), the [bounty round](docs/integration-notes.md#bounty-round-on-testnet-100-ticket-set-2026-11-07), the [agent round](docs/integration-notes.md#agent-round-through-the-mcp-server-2026-11-07) and the [mainnet round](docs/integration-notes.md#mainnet-round-2026-11-07).

### What is real and what is a demo

Kettle & Kiln is a fictional store, and its tickets are synthetic. The project's author controls both the owner's account, `bakeoff.near`, and the winning builder's, `agent.bakeoff.near`, so the mainnet round shows the whole flow working, not a contest between strangers. The contract pays any account other than the owner. Everything else in the round is real: the contract on mainnet, the scoring inside OutLayer's enclave, the model calls to NEAR AI Cloud and the 1 NEAR payment. The board labels every round as a demo.

### What you still have to trust

A result can only come from the enclave: `on_evaluation_result` is private and runs as the callback of the contract's own `request_execution` call to OutLayer. The one key that could change that is the challenge account's own, which could deploy different code. `scripts/near/open.sh` deletes it when it opens a challenge, so from then on no key, Bakeoff's or the owner's, can write a result; the challenge page shows "Locked · 0 keys" once it is gone. The contract checks every hash, but some things are beyond what it can check:
- **The owner's test cases.** The owner writes and labels them and sets the requirements. The evaluator scores a poor test as faithfully as a good one, so a pass is only as meaningful as the cases.
- **The enclave.** The test cases and API key stay hidden because OutLayer's TEE hardware and attestation hold. The contract cannot see inside the enclave.
- **The model provider.** NEAR AI Cloud processes each hidden case to answer it, and reports the token usage each result's cost is computed from.
- **The board's listings.** Titles, descriptions and baselines come from the owner's published listing. Rewards, results and payments are read from the contract.

## How it would pay for itself

Not built yet. The plan is a fee on each awarded reward, taken by the contract at payout, so a team pays nothing when no result passes. The first customers are teams already running an agent on NEAR AI Cloud: they have a bill to cut and a baseline to beat. Compared with hiring a consultant, a team pays only for a result that cleared its own hidden tests, and gets the winning config with the evidence behind it.

## Hackathon disclosure

Built for NEAR HACKATHON. The first commit is from 2026-11-06, inside the window that opened on 2026-10-19; no code predates it.

- **Libraries.** Rust: near-sdk, near-workspaces, serde, serde_json, sha2, wasi, tokio, anyhow. Board: React, React Router, Motion, NEAR Connect (`@hot-labs/near-connect`), Vite, TypeScript, the Geist and Instrument Serif fonts. MCP server: the Model Context Protocol TypeScript SDK, Zod.
- **Tools.** near-cli-rs, the OutLayer CLI, cargo-near, wasmtime.
- **AI tools.** Claude Code (Anthropic) was used throughout for code, tests and documentation.
- **Other project.** The same team lead also submitted **Bearer**, an independent project. The two share no code.

## License

Licensed under either of the [Apache License, Version 2.0](LICENSE-APACHE) or the [MIT license](LICENSE-MIT), at your option.
