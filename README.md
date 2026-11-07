# Bakeoff

Sealed bake-offs for AI agents. A business posts its agent's baseline, a sealed test set and pass gates (quality, cost, latency, data-leak rules), and escrows a bounty. Contributors submit configuration changes. Each candidate is scored inside an OutLayer TEE on NEAR, and the verdict is recorded on-chain only if it names the exact rules, candidate and test set the challenge committed to. The first candidate that passes every gate is paid the bounty by the contract.

The sealed test set and the model API key are OutLayer secrets bound to one evaluator build. They are decrypted only inside the enclave, and only for calls that come through the challenge contract.

## How a sealed evaluation runs

1. A contributor calls `submit(config_json)` on the challenge contract, attaching 0.035 NEAR and 220+ Tgas. The contract keeps 0.01 NEAR to pay for the evaluation record and forwards the rest to OutLayer, which refunds what the run does not use.
2. The contract calls `request_execution` on OutLayer with the evaluator pinned by its SHA-256, the challenge rules and the candidate as input, and a reference to the challenge's secrets.
3. An OutLayer TEE worker runs the evaluator (`wasm32-wasip2`). The evaluator checks the candidate against the rules before spending anything, then triages every sealed ticket through NEAR AI Cloud, measuring accuracy, cost from token usage, latency and card-number leaks.
4. The evaluator prints a verdict of under 900 bytes: aggregate metrics plus SHA-256 digests of the rules, candidate and test set it scored. No per-ticket data leaves the enclave.
5. The contract records the verdict as `Passed` or `Failed`, or as `Rejected` if the execution failed or any digest differs from its commitments.
6. If this is the first `Passed` verdict for a submission made while the challenge was open, by anyone but the owner, the contract awards the bounty and transfers it to the submitter in the same callback.

## The bounty

| Step | Who | Call | Allowed |
|---|---|---|---|
| Escrow | owner | `fund()` with the amount attached | while a draft, or open before the deadline |
| Open | owner | `open(closes_at)`, nanoseconds since the epoch | once, from draft; freezes the commitments |
| Win | contract | from the result callback | first passing submission made while open, not by the owner |
| Retry a failed payout | anyone | `claim_award()` | when an award is owed and no payment is in flight |
| Refund | owner | `withdraw_bounty()` | any time in draft; after the deadline with no winner and no pending evaluation |

- A submission made before the deadline can still win after it. OutLayer answers within the yield window, about two minutes, and the refund waits until it does.
- The owner's own submissions, in draft or open, are trial runs. Their verdicts are recorded but never win the bounty.
- Every change of state emits a NEP-297 event (standard `bakeoff`, version 1.1.0): `bounty_funded`, `challenge_opened`, `evaluation_requested`, `evaluation_settled`, `bounty_awarded`, `award_paid`, `award_payment_failed`, `challenge_closed`, `bounty_withdrawn`.

## Repository layout

| Path | Contents |
|---|---|
| `evaluator/` | Rust evaluator: policy checks, grading, cost accounting, verdicts, and a `wasi:http` client |
| `contract/` | NEAR challenge contract (near-sdk 5) |
| `tools/` | Mock OpenAI-compatible model API, mock OutLayer contract, request builder, JSON-RPC view helper |
| `integration-tests/` | Sandbox end-to-end tests of the contract |
| `web/` | Static web board: live challenges and verdicts, in-browser checks of the commitments, sponsor funding from a NEAR wallet or any chain through 1Click |
| `mcp/` | MCP server that lets AI agents find challenges, score candidates on the practice set with the pinned evaluator, and submit them for the bounty |
| `examples/rules/` | Challenge rules for local runs and for NEAR AI Cloud |
| `examples/candidates/` | Example candidates covering each outcome |
| `data/tickets/` | Synthetic tickets for a fictional store. Card numbers are public test numbers |
| `scripts/` | Local runs, contract build, testnet deployment |
| `docs/` | Integration notes |

## The web board

[`web/`](web/README.md) is a static page that reads every number from the challenge contracts:
- the board of challenges;
- each challenge's verdicts and award;
- checks in the browser that the rules and the evaluator build match their on-chain hashes.

A sponsor connects a NEAR wallet to fund, open or withdraw a challenge. On mainnet they can fund it from about 200 tokens on about 40 chains through NEAR Intents' 1Click: the swap delivers wNEAR to the sponsor's own account, and one approval unwraps it and funds the bounty.

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
7. Escrow the bounty and open the challenge, here 1 NEAR for 72 hours:
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

A mainnet challenge costs about 2.5 NEAR, most of it the contract's refundable storage. On top of that come the 0.245 NEAR secret deposit, about 0.012 NEAR of OutLayer compute per sealed run, and the bounty.

## Status

Verified locally:
- the evaluator and contract unit tests pass;
- the wasm evaluator produces the expected verdict for every example under wasmtime;
- verdicts are 345–545 bytes;
- a 16-ticket run uses 2–4 million instructions;
- in a NEAR sandbox, a submission settles as `Passed` with the real evaluator's verdict;
- in the same sandbox, a verdict scored on a different test set and a failed execution are both recorded as `Rejected`;
- in the same sandbox, a funded challenge pays its 5 NEAR bounty to the first passing contributor and then refuses submissions, each evaluation record fits within the 1 KB its fee pays for, and an unwon bounty returns to the owner only after the deadline.

Verified on NEAR testnet with OutLayer and NEAR AI Cloud:
- sealed evaluations ran inside OutLayer's TEE, with the test set and API key injected only for the pinned evaluator build;
- every recorded verdict's digests matched the challenge's commitments;
- on a 16-ticket sample, four candidates were recorded with the expected outcomes: a policy rejection, an accuracy failure, a latency failure, and one `Passed` at 93.75% accuracy, 98 µ$ per ticket and 6.0 s p95;
- on the 100-ticket sealed set, with gates calibrated from the sponsor's baseline, the first five candidates failed. The baseline missed the cost gate, and two cheaper candidates fell below the accuracy gate after passing on the public practice set. The most accurate cheap candidate cleared accuracy, cost and latency, and was failed for repeating a customer's card number;
- a sixth candidate, written from that failure reason and the practice set alone, `Passed` on its only sealed submission at 91.0% accuracy, 87 µ$ per ticket, 3.8 s p95 and no leaks. That evaluator did not yet require a summary, and about half that candidate's replies had none;
- in a bounty round on the same sealed set, with an evaluator that requires a summary and gates recalibrated from the median of three baseline runs, the sponsor ran two trials, escrowed 1 NEAR and opened the challenge. A contributor's first submission, `few-shot-guided`, passed at 93.0% accuracy, 72 µ$ per ticket (41% below the baseline's 122 µ$ in the same round), 2.9 s p95 and no leaks, and the contract paid it the bounty in the same transaction;
- in an agent round, the sponsor funded and opened a fresh challenge from the web board, and a Claude Code agent competed through the MCP server. Its first sealed submission passed at 97.0% accuracy, 63 µ$ per ticket, 3.5 s p95 and no leaks, beating the hand-written winner, and the contract paid it the 1 NEAR bounty;
- submission to recorded verdict took 8–71 s.

Results and transaction links are in the integration notes, for the [16-ticket sample](docs/integration-notes.md#sealed-runs-on-testnet-16-ticket-sample-2026-11-07), the [100-ticket set](docs/integration-notes.md#sealed-runs-on-testnet-100-ticket-set-2026-11-07) and the [bounty round](docs/integration-notes.md#bounty-round-on-testnet-100-ticket-set-2026-11-07) and the [agent round](docs/integration-notes.md#agent-round-through-the-mcp-server-2026-11-07).
