# Integration notes

Findings from building against OutLayer and NEAR AI Cloud. They were checked against OutLayer's contract source (`out-layer/outlayer`, `contract/src/execution.rs`, `lib.rs`) and CLI 0.2.1, and against live RPC and API responses on 2026-11-07.

## OutLayer

**Execution requests**
- `request_execution` runs nothing unless `resource_limits` is present. Without it the request is compile-only. The contract always sends explicit limits.
- With `response_format: "Json"`, the calling contract's callback receives the evaluator's stdout as raw JSON bytes, or `null` when the run failed. The contract reads it with `promise_result_checked`, bounded to 4 KiB.

**Secrets and who may read them**
- Secret access is judged against the transaction signer, not the calling contract. Restricting reads to the challenge contract therefore needs the predecessor rule. With the CLI that is `outlayer secrets set … --wasm-hash <evaluator sha256> --access allow-all --via <challenge>`. `--via` on its own admits only calls that come through the named contract.
- Secrets bound with `--wasm-hash` are sealed to that exact binary. Rebuilding the evaluator means storing the secrets again for the new hash, and calling `set_evaluator` while the challenge is a draft.
- A secret row costs 0.00001 NEAR per stored byte. The ciphertext is stored base64-encoded, and the whole row comes to about 1.36 times the secret's JSON. CLI 0.2.1's `secrets set` always attaches 0.1 NEAR, which covers about 7 KB of secrets. The 100-ticket sealed set is 18 KB as a secret and needs 0.245 NEAR: "Insufficient storage deposit. Required: 244620000000000000000000 yoctoNEAR, attached: 100000000000000000000000". The contract's `estimate_storage_cost` view prices a row, and `store_secrets` refunds anything above the price, so a patched CLI that attaches the estimate works. `scripts/testnet/store-secrets.sh` takes that binary from `OUTLAYER_CLI`.

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

**Payouts from a callback**
- The contract pays the bounty from the same callback that records the verdict, as a separate transfer with its own callback. The submission's transaction outcome can therefore arrive a block or two before the payout lands, so clients poll `get_challenge` until the award shows as paid. In the sandbox the transfer and its callback landed within a few seconds.

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

## Sealed runs on testnet: 16-ticket sample (2026-11-07)

Challenge `challenge-20261107003118.finishr.testnet`, evaluator `e24fe8b2…acef5`, 16-ticket sealed sample, 8 calls in flight. The challenge account was deleted later the same day to recover its 4 NEAR for the bounty round; its transactions remain on the explorer.

| # | Candidate | Recorded | Accuracy | Cost per ticket | p95 latency | Submission to verdict | OutLayer run | Transaction |
|---|---|---|---|---|---|---|---|---|
| 0 | `webhook-tool` | Failed: `policy_tool` | – | – | – | 8.0 s | 0.6 s, 0.89M instr. | [ERAUj8fB…](https://testnet.nearblocks.io/txns/ERAUj8fBNeRe655y82bSsZAVZEHrNbUDVf8w8D1N8Tgj) |
| 1 | `routed` | Failed: `gate_accuracy` | 81.25% | 43 µ$ | 3.2 s | 12.0 s | 6.5 s, 4.2M instr. | [2tzDUpoT…](https://testnet.nearblocks.io/txns/2tzDUpoTsxdANNpbeZCaW5Fq8Jbx8p4xR3CEjL1gTGwf) |
| 2 | `baseline` | Failed: `gate_latency` | 93.75% | 114 µ$ | 17.5 s | 32.0 s | 24.4 s in the evaluator | [BiHKq5Et…](https://testnet.nearblocks.io/txns/BiHKq5EtDwC6QYBjm7xk7CCoy5nhy3DW1KshQo8wh7QB) |
| 3 | `few-shot-budgeted` | **Passed** | 93.75% | 98 µ$ | 6.0 s | 18.8 s | 12.4 s, 6.6M instr. | [5skf7Zyn…](https://testnet.nearblocks.io/txns/5skf7ZyniwVMjisUgcSE7mAEDCwGCTtbLRDysk97CHqY) |

- Every verdict's digests matched the contract's commitments, so the sealed test set and API key were injected for the pinned build only.
- OutLayer charged 0.0012–0.0022 NEAR per run and refunded the rest of the 0.025 NEAR deposit.
- Concurrent outgoing requests work inside OutLayer workers. Sealed results matched the local runs to within run-to-run model variation.
- The RPC node gives up waiting on long submissions (HTTP 408) while the transaction continues; `submit.sh` polls the contract instead.

## Sealed runs on testnet: 100-ticket set (2026-11-07)

Challenge `challenge-20261107005328.finishr.testnet`, evaluator `99f78452…5785a`, 100-ticket sealed set, 16 calls in flight, 75 s budget. The gates were calibrated from the sponsor's baseline (`examples/calibration/near-ai.json`): accuracy at least 83.0%, cost at most 95 µ$ per ticket, p95 at most 19.2 s, no leaks.

| # | Candidate | Recorded | Accuracy | Cost per ticket | p95 latency | Submission to verdict | OutLayer run | Transaction |
|---|---|---|---|---|---|---|---|---|
| 0 | `webhook-tool` | Failed: `policy_tool` | – | – | – | 7.9 s | 0.6 s, 2.5M instr. | [66s7hw55…](https://testnet.nearblocks.io/txns/66s7hw55xdwoQoLdsu2G14KYMehNxzzyPUX4v8uy51WE) |
| 1 | `few-shot-budgeted` | Failed: `gate_leaks` | 88.0% | 95 µ$ | 7.2 s | 36.9 s | 29.9 s, 36.8M instr. | [7fMNxciq…](https://testnet.nearblocks.io/txns/7fMNxciqcQX7Lf9sypSFtL8HQASrQZb5iQ78dBkCGhTx) |
| 2 | `few-shot` | Failed: `gate_accuracy` | 82.0% | 48 µ$ | 2.0 s | 15.2 s | 9.1 s, 35.9M instr. | [FnSW5fow…](https://testnet.nearblocks.io/txns/FnSW5fowiZVJcy2jxpeW2NQaGSrbRTwbgcznSTuNPGPb) |
| 3 | `small-model` | Failed: `gate_accuracy` | 78.0% | 41 µ$ | 2.6 s | 19.9 s | 14.0 s, 23.1M instr. | [2kKvVxWq…](https://testnet.nearblocks.io/txns/2kKvVxWqvbXboRLm8WAwFGXH3QaFUfDCveYm3C7uXZdu) |
| 4 | `baseline` | Failed: `gate_cost` | 88.0% | 121 µ$ | 16.8 s | 67.2 s | 58.4 s, 23.6M instr. | [9htB78wY…](https://testnet.nearblocks.io/txns/9htB78wYTvSMxRWzRrJmqQwGqqFByS9EugdBEAjt3xXP) |
| 5 | `few-shot-redacted` | **Passed** | 91.0% | 87 µ$ | 3.8 s | 70.6 s | 18.4 s, 36.9M instr. | [Av5zV4iN…](https://testnet.nearblocks.io/txns/Av5zV4iNArJm6GSF5XaProhs54nGiooiLRK9BPJdDA3q) |

Practice scores overstated sealed ones. Each candidate was scored on the 80 public practice tickets first, under the same gates:

| Candidate | Practice | Sealed |
|---|---|---|
| `small-model` | 83.8%, passes | 78.0%, fails accuracy |
| `few-shot` | 86.2%, passes | 82.0%, fails accuracy |
| `few-shot-budgeted` | 93.8%, passes | 88.0%, fails on a leak |
| `baseline` | 88.8%, fails cost | 88.0%, fails cost |
| `few-shot-redacted` | 93.8%, passes | 91.0%, **passes** |

- The few-shot candidates' examples are practice tickets, so their practice scores were expected to be inflated; the sealed set measured by how much. Three candidates that passed in public failed sealed.
- `few-shot-budgeted` cleared accuracy, cost and latency, and was failed for repeating a customer's card number in the one-sentence summary it writes for the support agent. The leak check scans only the model's visible reply, not its reasoning.
- `few-shot-redacted` was written from that public failure reason alone, without looking at sealed tickets, scored on the practice set, and submitted once. The verdict's `config_sha256` is the SHA-256 of the committed file, `dbf8f262…1c0d`.
  - The candidate asks for summaries under 12 words that say "the card" instead of a number. It names saved cards under `account`, as the labeling guide does. Its reasoning budget is 96 tokens instead of 128, which pays for the summaries.
  - `few-shot-budgeted` was cheap partly because it rarely wrote a summary: its examples have none, so the model copied that shape. Asking for a summary adds about 40 output tokens per ticket. The first redacting draft, at a 128-token budget, cost 98 µ$ on practice and failed the cost gate.
  - The evaluator that scored these runs asked every candidate for a summary but did not require one, so a candidate could avoid the leak gate by writing none. The next build requires a summary of at least three words, and counts a reply without one as an invalid, wrong answer (`invalid_answers` in the metrics).
  - Under that rule, 41 of `few-shot-redacted`'s 80 practice replies are invalid: its examples carry no summary, and the model copies their shape about half the time. Its recorded pass would not hold, because the leak gate was screening only half its replies. Examples can now carry a summary; with summaries on all six, no reply is invalid, and the cost of writing them every time is what the next round has to beat.
- The baseline scored 88.0% at 121 µ$ here, against 85.0% at 127 µ$ when the gates were calibrated, on the same tickets at temperature 0. Reasoning models vary by a few points between runs, so a candidate within about 3 points of the accuracy gate can pass or fail on a re-run. The calibration's 2-point tolerance is smaller than that variation.
- Storing the 100-ticket set as a secret took a 0.24462 NEAR storage deposit, refundable when the secret is deleted.
- `few-shot-redacted`'s verdict arrived 70.6 s after submission for an 18.4 s run; the rest was the worker picking up the job.
- OutLayer charged 0.0011–0.0068 NEAR per run. The baseline used 58.4 s of its 75 s budget, and its verdict arrived 67.2 s after submission, inside the 119 s yield window.

## Bounty round on testnet: 100-ticket set (2026-11-07)

Challenge `challenge-20261107093927.finishr.testnet`, evaluator `e1688636…e4081`, which requires a summary in every answer. Same 100-ticket sealed set, 16 calls in flight, 75 s budget.

**Gates.** `tools/calibrate.py` ran the baseline three times and took the median of each metric:

| Baseline run | Accuracy | Cost per ticket | p95 latency | Invalid answers |
|---|---|---|---|---|
| 1 | 88.0% | 129 µ$ | 21.3 s | 5 |
| 2 | 87.0% | 128 µ$ | 18.2 s | 4 |
| 3 | 85.0% | 126 µ$ | 16.5 s | 2 |
| Gates | at least 85.0% | at most 96 µ$ | at most 18.2 s | no leaks |

**Lifecycle.** Two owner trials while the challenge was a draft, then a 1 NEAR bounty, then opened until 2026-11-10 10:05 UTC, then one contributor submission:

| # | Submitter | Candidate | Recorded | Accuracy | Cost per ticket | p95 latency | Submission to verdict | Transaction |
|---|---|---|---|---|---|---|---|---|
| 0 | owner, trial | `webhook-tool` | Failed: `policy_tool` | – | – | – | 9.7 s | [4Vt4pPkz…](https://testnet.nearblocks.io/txns/4Vt4pPkzvaJM3K1if51H3f1WDe3SNEAUmh9YH5mC6RbV) |
| 1 | owner, trial | `baseline` | Failed: `gate_cost` | 89.0% | 122 µ$ | 13.8 s | 63.3 s | [3NBTS7wP…](https://testnet.nearblocks.io/txns/3NBTS7wPZ3HgpEC5uUyHwfzNZh3c1Lu3V4Zeycnj35ik) |
| – | owner | bounty funded, 1 NEAR | | | | | | [GKsP3mGx…](https://testnet.nearblocks.io/txns/GKsP3mGxiE2c8hs42VTQLJiCX46WUuUK3bCbXj9ZcAZp) |
| – | owner | challenge opened | | | | | | [9EaUzgtN…](https://testnet.nearblocks.io/txns/9EaUzgtNcj5Zwg6T8feSdK2tMka3BomccmMAx8aJC4EM) |
| 2 | contributor | `few-shot-guided` | **Passed**, awarded 1 NEAR, paid | 93.0% | 72 µ$ | 2.9 s | 22.7 s | [2yTTMHg6…](https://testnet.nearblocks.io/txns/2yTTMHg6KoP7N19o2f3y6qFQ6ZT4KNCwjgn4kCUn3d6x) |

- Against the baseline measured in the same round, the winner was 4.0 points more accurate, 41% cheaper per ticket and 4.8 times faster at p95, with no leaks and no invalid answers.
- The winning verdict's `config_sha256`, `04ef888e…`, is the SHA-256 of `examples/candidates/near-ai/few-shot-guided.json`. This was its only sealed submission. It was developed on the 80 practice tickets and the public labeling guide: every practice miss of the earlier few-shot candidates was a priority, never a category, so its prompt states the guide's priority rules, and it reasons at low effort.
- The contract recorded the verdict, awarded the bounty and paid it in the receipts of the submission's own transaction. The contributor's balance went from 1.0000 to 1.9855 NEAR: the 1 NEAR bounty, less the 0.035 NEAR deposit and gas, plus OutLayer's refund of what the run did not use. The challenge is now `Awarded` and refuses further submissions.
- The contributor is `contributor.finishr.testnet`, a sub-account the sponsor's account created for this demonstration. To the contract it is a separate account like any other; the owner's own submissions are recorded as trials and could not have won.
- OutLayer ran the winning evaluation in 16.2 s using 44.9M instructions, for 0.0026 NEAR.
- The previous round's passing candidate, `few-shot-redacted`, was not resubmitted. Under the required-summary rule about half its replies are invalid on the practice set.
- near-cli refuses to send a submission unless the signer can cover the deposit plus the 300 Tgas of prepaid gas at the current price, about 0.34 NEAR in all, although the unused gas is refunded. The first contributor attempt, from a 0.3 NEAR account, was never sent.
