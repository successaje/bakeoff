# Bakeoff

Sealed bake-offs for AI agents. A business posts its agent's baseline, a sealed test set and pass gates (quality, cost, latency, data-leak rules). Contributors submit configuration changes. Each candidate is scored inside an OutLayer TEE on NEAR, and the verdict is recorded on-chain only if it names the exact rules, candidate and test set the challenge committed to.

The sealed test set and the model API key are OutLayer secrets bound to one evaluator build. They are decrypted only inside the enclave, and only for calls that come through the challenge contract.

## How a sealed evaluation runs

1. A contributor calls `submit(config_json)` on the challenge contract, attaching 0.025 NEAR and 200+ Tgas.
2. The contract calls `request_execution` on OutLayer with the evaluator pinned by its SHA-256, the challenge rules and the candidate as input, and a reference to the challenge's secrets.
3. An OutLayer TEE worker runs the evaluator (`wasm32-wasip2`). The evaluator checks the candidate against the rules before spending anything, then triages every sealed ticket through NEAR AI Cloud, measuring accuracy, cost from token usage, latency and card-number leaks.
4. The evaluator prints a verdict of under 900 bytes: aggregate metrics plus SHA-256 digests of the rules, candidate and test set it scored. No per-ticket data leaves the enclave.
5. The contract records the verdict as `Passed` or `Failed`, or as `Rejected` if the execution failed or any digest differs from its commitments.

## Repository layout

| Path | Contents |
|---|---|
| `evaluator/` | Rust evaluator: policy checks, grading, cost accounting, verdicts, and a `wasi:http` client |
| `contract/` | NEAR challenge contract (near-sdk 5) |
| `tools/` | Mock OpenAI-compatible model API, request builder, JSON-RPC view helper |
| `examples/rules/` | Challenge rules for local runs and for NEAR AI Cloud |
| `examples/candidates/` | Example candidates covering each outcome |
| `data/tickets/` | Synthetic tickets for a fictional store. Card numbers are public test numbers |
| `scripts/` | Local runs, contract build, testnet deployment |
| `docs/` | Integration notes |

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

To score candidates against NEAR AI Cloud from your machine, put `BAKEOFF_LLM_API_KEY` in `.env`, then:

```bash
scripts/run-local.sh --rules examples/rules/near-ai.json
```

## Testnet deployment

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
   scripts/testnet/deploy.sh
   ```
5. Store the sealed test set and API key as secrets bound to the evaluator build:
   ```bash
   scripts/testnet/store-secrets.sh
   ```
6. Run a sealed evaluation and wait for the verdict:
   ```bash
   scripts/testnet/submit.sh examples/candidates/near-ai/routed.json
   ```

## Status

Verified locally:
- the evaluator and contract unit tests pass;
- the wasm evaluator produces the expected verdict for every example under wasmtime;
- verdicts are 345–545 bytes;
- a 16-ticket run uses 2–4 million instructions.

Not yet verified: a sealed run on OutLayer testnet. [docs/integration-notes.md](docs/integration-notes.md) lists what that run has to confirm.
