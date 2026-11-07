# Integration notes

Findings from building against OutLayer and NEAR AI Cloud. They were checked against OutLayer's contract source (`out-layer/outlayer`, `contract/src/execution.rs`, `lib.rs`) and CLI 0.2.1, and against live RPC and API responses on 2026-11-07.

## OutLayer

**Execution requests**
- `request_execution` runs nothing unless `resource_limits` is present. Without it the request is compile-only. The contract always sends explicit limits.
- With `response_format: "Json"`, the calling contract's callback receives the evaluator's stdout as raw JSON bytes, or `null` when the run failed. The contract reads it with `promise_result_checked`, bounded to 4 KiB.

**Secrets and who may read them**
- Secret access is judged against the transaction signer, not the calling contract. Restricting reads to the challenge contract therefore needs the predecessor rule. With the CLI that is `outlayer secrets set … --wasm-hash <evaluator sha256> --access allow-all --via <challenge>`. `--via` on its own admits only calls that come through the named contract.
- Secrets bound with `--wasm-hash` are sealed to that exact binary. Rebuilding the evaluator means storing the secrets again for the new hash, and calling `set_evaluator` while the challenge is a draft.

**The real time limit is the yield window, not 180 s**
- OutLayer returns a result by resuming a NEAR yield. A yield times out after 200 blocks. On testnet that measured 202 blocks and 118.9 s between `request_execution` and the timeout callback.
- If a run outlives the yield, the worker's `resolve_execution` is refused with "Execution request not found". The caller receives `null`, and OutLayer refunds the deposit minus a 0.001 NEAR base fee.
- The first sealed testnet run hit exactly this: 16 tickets, sequential calls, GLM-5.3 Flash with full reasoning. The worker ran the evaluator for 115.8 s using 3.9M instructions, and the result arrived after the yield had expired. The contract recorded it as `Rejected: execution_failed`, as designed.
- Consequences:
  - the rules cap `time_budget_ms` at 100 s;
  - the contract requests 110 s of execution;
  - the evaluator runs model calls concurrently and gives each batch only the remaining budget.
- OutLayer's public job log is at `https://testnet-api.outlayer.ai/public/jobs` (mainnet: `api.outlayer.ai`). It shows per-job worker, status, instructions, execution time and error details.

**Cost**
- `estimate_execution_cost` returns 0.0190001 NEAR on both testnet and mainnet for 1B instructions, 128 MB and 180 s. Time dominates: 30 s costs about 0.004 NEAR.
- Unused deposit is refunded to `payer_account_id`, which the contract sets to the submitter.

## WASI HTTP

- `wasi-http-client` 0.2.1, which OutLayer's AI example uses, writes the whole request body with a single `blocking-write-and-flush`. WASI caps that call at 4096 bytes, and a prompt with examples exceeds it. `evaluator/src/wasi_http.rs` writes in 4 KiB chunks.
- Without an explicit `Content-Length` the host sends the body chunked, which some servers reject. The client always sets it.
- The client sets connect, first-byte and between-bytes timeouts. Whether OutLayer's worker honours all three is unverified.

## Contract build

- cargo-near 0.11 fails with "Failed to validate wasm" on Rust 1.98 output. cargo-near 0.23 builds the contract (168 KB), and the result deploys and runs in a near-workspaces 0.24 sandbox. `scripts/build-contract.sh` refuses versions below 0.13.
- In the sandbox, a 300 Tgas submission covers the contract call, the 150 Tgas forwarded to `request_execution`, the yield, and the 20 Tgas result callback.

## Measured locally (wasmtime 50, mock API)

| Measure | Value |
|---|---|
| Evaluator binary | 260 KB, `wasm32-wasip2`, release |
| Instructions for a 16-ticket run (18 model calls) | 2–4 million (fails at 2M fuel, passes at 4M) |
| Verdict size | 345–545 bytes |

## NEAR AI Cloud

- OpenAI-compatible endpoint: `https://cloud-api.near.ai/v1/chat/completions`. `/v1/models` publishes per-token prices and the sampling parameters each model accepts.
- Models owned by `nearai` are served from NEAR AI's attested TEE infrastructure. The live rules allow only confidential models: `z-ai/glm-5.3-flash`, `Qwen/Qwen3.6-35B-A3B-FP8` and `qwen/qwen3.5-397b-a17b`.
- Some models accept no sampling parameters (for example `deepseek-ai/DeepSeek-V4.1-Flash-1017`), so `temperature` is optional in the rules and omitted when unset.

## Measured against NEAR AI Cloud (from a laptop, 16 sealed-sample tickets)

All runs use GLM-5.3 Flash. The first run was sequential; the rest had 8 calls in flight.

| Candidate | Accuracy | Cost per ticket | p95 latency | Wall clock |
|---|---|---|---|---|
| Full reasoning, sequential | 87.5% | 106 µ$ | 17.3 s | 130.7 s |
| Full reasoning (`baseline`) | 93.8% | 111 µ$ | 17.9 s | 31.9 s |
| Reasoning capped at 256 tokens (`budgeted`) | 87.5% | 101 µ$ | 13.3 s | 24.3 s |
| Minimal reasoning plus 6 examples (`few-shot`) | 81.2% | 49 µ$ | 8.1 s | 10.5 s |
| Minimal reasoning, escalate when unsure (`routed`) | 81.2% | 43 µ$ | 3.9 s | 6.5 s |
| Minimal reasoning (`small-model`) | 75.0% | 41 µ$ | 3.1 s | 6.0 s |

- GLM-5.3 Flash reasons by default with an 8192-token budget. `reasoning_effort: "low"` cuts the cost to about a third and the latency to about a fifth, at a loss of accuracy.
- With minimal reasoning the model reported confidence of at least 0.7 on every ticket, including wrong ones, so confidence-based escalation never fired.
- `qwen/qwen3.5-397b-a17b` was too slow for the window: two calls hit the 60 s first-byte timeout and the run cost 721 µ$ per ticket.
- An account without credits gets HTTP 402 on every call.

## Sealed runs on testnet (2026-11-07)

Challenge `challenge-20261107003118.finishr.testnet`, evaluator `e24fe8b2…acef5`, 16-ticket sealed sample, 8 calls in flight.

| # | Candidate | Recorded | Accuracy | Cost per ticket | p95 latency | Submission to verdict | OutLayer run | Transaction |
|---|---|---|---|---|---|---|---|---|
| 0 | `webhook-tool` | Failed: `policy_tool` | – | – | – | 8.0 s | 0.6 s, 0.89M instr. | [ERAUj8fB…](https://testnet.nearblocks.io/txns/ERAUj8fBNeRe655y82bSsZAVZEHrNbUDVf8w8D1N8Tgj) |
| 1 | `routed` | Failed: `gate_accuracy` | 81.25% | 43 µ$ | 3.2 s | 12.0 s | 6.5 s, 4.2M instr. | [2tzDUpoT…](https://testnet.nearblocks.io/txns/2tzDUpoTsxdANNpbeZCaW5Fq8Jbx8p4xR3CEjL1gTGwf) |
| 2 | `baseline` | Failed: `gate_latency` | 93.75% | 114 µ$ | 17.5 s | 32.0 s | 24.4 s in the evaluator | [BiHK5EtD…](https://testnet.nearblocks.io/txns/BiHKq5EtDwC6QYBjm7xk7CCoy5nhy3DW1KshQo8wh7QB) |
| 3 | `few-shot-budgeted` | **Passed** | 93.75% | 98 µ$ | 6.0 s | 18.8 s | 12.4 s, 6.6M instr. | [5skf7Zyn…](https://testnet.nearblocks.io/txns/5skf7ZyniwVMjisUgcSE7mAEDCwGCTtbLRDysk97CHqY) |

- Every verdict's digests matched the contract's commitments, so the sealed test set and API key were injected for the pinned build only.
- OutLayer charged 0.0012–0.0022 NEAR per run and refunded the rest of the 0.025 NEAR deposit.
- Concurrent outgoing requests work inside OutLayer workers. Sealed results matched the local runs to within run-to-run model variation.
- The RPC node gives up waiting on long submissions (HTTP 408) while the transaction continues; `submit.sh` polls the contract instead.
