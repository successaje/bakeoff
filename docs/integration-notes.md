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

### Reproducible build (2026-11-18)

- `cargo near build reproducible-wasm` (cargo-near 0.23 on the host) builds in `sourcescan/cargo-near:0.22.0-rust-1.99.1`, the image cargo-near 0.23's own project template pins, by digest `sha256:c9655eaf…43b5bb`. The image is linux/amd64 only, 509 MB compressed. On an arm64 Mac it runs under emulation and a build takes about 5.5 minutes.
- Commit `845b5c3` built three times to the same 203,166 bytes and code hash `3gQRwG6bH2P2e4cb27JcKYEDtVeF8JBjxcR4xvcPgAWt`: twice from fresh worktrees at different paths, and once by `scripts/near/verify-contract.sh`, which fetched the commit from GitHub. That run used a local stand-in RPC reporting the commit and hash, and printed the match.
- Across machines: CI's reproducible job built commit `593cbf5` on GitHub's x86_64 runner in about 40 seconds, to contract code hash `AqsszcSJb6634mByXJDMo74faiJL7NqMrXnkJ6GgEefc`. The same commit built on an arm64 Mac, under emulation, gave the same hash.
- The build embeds its NEP-330 metadata in the contract. `contract_source_metadata` returns `link` (the repository at the commit) and `build_info`: `build_environment` (the image and digest), `build_command`, `contract_path: "contract"` and `source_code_snapshot: "git+https://github.com/successaje/bakeoff?rev=<commit>"`. Since the commit is in the code, every commit builds to a different hash, even one that changes only documentation. What stays fixed is that the same commit always gives the same hash.
- Challenges deployed before this change return `"build_info": null`: they were built with the host's toolchain and name no commit.
- The build refuses a working tree with uncommitted changes. A clean `git worktree` builds the committed source without disturbing a working checkout.

## Paying a winner into NEAR Intents (sandbox, 2026-11-17)

How the contract talks to the two mainnet contracts, from NEAR Intents' deposit guide and wrap.near's interface:
- **wrap.near** registers an account for 0.00125 NEAR (`storage_deposit` with `registration_only`), wraps attached NEAR with `near_deposit`, and unwraps with `near_withdraw`, which needs 1 yoctoNEAR attached. An account already registered gets its deposit back.
- **intents.near** takes a NEP-141 deposit through the token's `ft_transfer_call`, with the account to credit as `msg`, and holds it under the token id `nep141:wrap.near`. The guide budgets about 100 Tgas for the call; the contract attaches 100 Tgas to it and asks `claim_award` for 160 Tgas in all.
- The contract sends registration, wrap and deposit as one batch of three function calls to wrap.near, so a failure in any of them reverts all three and refunds the attached NEAR. The callback reads `ft_transfer_call`'s result, the amount the verifier kept, and owes the rest as NEAR.

Measured with mocks of both contracts in a near-workspaces sandbox (`a_winner_can_take_the_bounty_into_near_intents`, `a_refused_intents_deposit_comes_back_and_is_paid_as_near`):
- A 5 NEAR award, claimed with 200 Tgas, leaves 4.99875 NEAR in the winner's Intents balance and 0.00125 NEAR with the token.
- With the verifier refusing, the 4.99875 wNEAR comes back to the contract; a second claim with 100 Tgas unwraps it, and the winner's balance rises by exactly 4.99875 NEAR.
- The contract's wasm grew from 186,518 to 204,062 bytes, so a new challenge locks about 0.18 NEAR more storage.

Not yet run on mainnet. A first mainnet test needs a challenge deployed from this build with a small bounty, won by a submission with `payout: "Intents"`.

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

## Attested model answers (2026-11-18)

What NEAR AI Cloud returns, and what checking it costs, measured against `z-ai/glm-5.3-flash`.

- **The report.** `GET /v1/attestation/report?model=…&nonce=…&signing_algo=ecdsa` needs no API key and returned 809 KB in 2.2 s, most of it NVIDIA evidence (about 98 KB per server). It listed three servers, each a separate TDX virtual machine with its own container setup, all holding the same signing key `0x3b753b4406613c5e70ae640508632b600424fa0c`.
- **What binds what.** In each server's TDX quote (version 4, 5,006 bytes), the first 32 bytes of `report_data` are the signing address, zero-padded, and the last 32 the request's nonce. `mr_config_id` is `01` followed by the SHA-256 of `info.tcb_info.app_compose`, and the GPU evidence's `nonce` field is the same nonce. All of this held for all three servers.
- **Signatures.** `GET /v1/signature/{chat_id}?model=…&signing_algo=ecdsa` takes the API key and answered in about 0.7 s. Its `text` was `model:sha256(request):sha256(response)`, and both hashes matched the exact bytes sent and received. The signature is Ethereum `personal_sign` (EIP-191), and it recovers to the attested address.
- **Intel's collateral.** It comes from Intel's own service, `api.trustedservices.intel.com`: the PCK CRL, TCB info and QE identity with their issuer chains in headers, plus the root CA CRL. That was 9.9 KB for the platform `90C06F000000`, and the quote verified as `UpToDate`. dcap-qvl's own collateral client needs reqwest, which has no WASI build, so the evaluator ports its few requests onto its own HTTP client.
- **Instructions in WebAssembly** (wasmtime's fuel meter, `wasm32-wasip2`):
  - size-optimized (`opt-level = "z"`, the workspace default), one quote cost about 420 million instructions and one signature 18 million;
  - with the elliptic-curve crates at `opt-level = 3`, about 290 million and 14.5 million;
  - k256's precomputed tables made no difference.
- **A whole run.** The 16-ticket sample with attestation required needed between 550 and 700 million instructions; the same candidate without it needed under 100 million. That came to 10.5 s, against 4.6 s without the check.
- **The limit.** Checking all three servers' quotes ran out of a billion instructions, so the evaluator checks one server per key, as NEAR AI's chat verifier does. A 100-ticket attested run needs about 2 billion. OutLayer's `estimate_execution_cost` for 110 s and 128 MB:

  | Instructions | Estimate |
  |---|---|
  | 1 billion | 0.0120001 NEAR |
  | 10 billion | 0.012001 NEAR |
  | 100 billion | 0.01201 NEAR |

  The contract now asks for 10 billion, and attested test sets hold at most 250 tickets.
- **On OutLayer (2026-11-24).** Owner trial `few-shot-guided` on `challenge-20261118175408.finishr.testnet`, over the 16-ticket sealed sample.
  - **Setup.** The rules are `examples/rules/near-ai-attested.json`. The evaluator is `c4d75cb7…`, 1.15 MB on FastFS. The contract is the reproducible build of `582f428`, code hash `FsqcVHi64uFDznY3Vycqo2DgfZtMt9TYGumbNhx3XPu7`, deployed locked (no access keys) in one transaction: create, fund 2.2 NEAR, deploy and `new`. `scripts/near/verify-contract.sh` rebuilt that commit from GitHub and matched the hash.
  - **The worker reached every service.** NEAR AI's signatures and attestation report, Intel's collateral and NVIDIA's attestation service all answered. The verdict, 664 bytes, records `"model_tee":{"answers":16,"signed":16,"signers":["0x3b753b4406613c5e70ae640508632b600424fa0c"],"tdx":"UpToDate"}`: `Passed` at 87.5% accuracy and 72 µ$ per ticket.
  - **Cost.** OutLayer's job log shows 539,580,955 instructions and 14.85 s of execution, after a 1.4 s compile. That is within the 550 to 700 million measured under wasmtime, and about half of the old 1 billion limit.
  - **Timing.** 41.1 s from request to recorded verdict.

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

Challenge `challenge-20261107005328.finishr.testnet`, evaluator `99f78452…5785a`, 100-ticket sealed set, 16 calls in flight, 75 s budget. The challenge account was deleted later the same day to recover its 3 NEAR for the demo challenge; its transactions remain on the explorer. The gates were calibrated from the sponsor's baseline (`examples/calibration/near-ai.json`): accuracy at least 83.0%, cost at most 95 µ$ per ticket, p95 at most 19.2 s, no leaks.

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

## Agent round through the MCP server (2026-11-07)

Challenge `challenge-20261107114823.finishr.testnet`, with the same calibrated rules, evaluator `e1688636…` and 100-ticket sealed set as the bounty round. The sponsor funded and opened it from the web board, and a Claude Code agent competed through the Bakeoff MCP server.

| Step | Who | Transaction |
|---|---|---|
| Fund 1 NEAR, signed in the web board through NEAR Connect | owner | [7rHZwpHB…](https://testnet.nearblocks.io/txns/7rHZwpHBnJtfw5DsLT6f1h8PvecyTLGsSL8h7dqmmxq4) |
| Open until 2026-11-10 12:12 UTC, signed in the web board | owner | [Frs8B985…](https://testnet.nearblocks.io/txns/Frs8B985CsQz5VxBpyMQoXzKNBTLeNjxn43RbsAdj2DA) |
| `submit_candidate` from the MCP server, signed by near-cli | `contributor.finishr.testnet` | [EuYwexug…](https://testnet.nearblocks.io/txns/EuYwexugUrjZbrUawLLinba6y3yy2xrraZZAnEBFDi4s) |

The agent's first and only sealed submission passed, and the contract paid it the 1 NEAR bounty with the verdict:

| Candidate | Accuracy | Cost per ticket | p95 latency | Leaks | Invalid answers |
|---|---|---|---|---|---|
| Baseline, median of the three calibration runs | 87.0% | 128 µ$ | 18.2 s | – | 2–5 |
| `few-shot-guided`, written by hand, bounty round | 93.0% | 72 µ$ | 2.9 s | 0 | 0 |
| **Agent's candidate** | **97.0%** | **63 µ$** | 3.5 s | 0 | 0 |

- The agent beat the hand-written winner on both accuracy and cost. Against the baseline's median it is 10 points more accurate and 51% cheaper per ticket, with p95 under a fifth of the baseline's.
- The config was recovered from the submission transaction's arguments, and its SHA-256 equals the verdict's `config_sha256`, `635e11db…`. It is saved byte for byte as `examples/candidates/near-ai/agent-zero-shot.json`.
- **What the agent changed.**
  - It used no few-shot examples, so every call is cheaper on input.
  - It wrote a 1,985-character prompt that condenses the public labeling guide: what each category covers, tie-breakers for the borderline cases, and the guide's priority rules.
  - It set `max_tokens` to 70 and `reasoning_effort` to low.
  - It told the model never to copy a card number into the summary.
- The config shares nothing with the earlier candidates in this repository beyond the model choice. Its taxonomy and tie-breakers are its own reading of the labeling guide that the MCP server's `get_labeling_guide` tool serves.

## Mainnet round (2026-11-07)

Challenge [`challenge-20261107153920.bakeoff.near`](https://nearblocks.io/address/challenge-20261107153920.bakeoff.near) on NEAR mainnet, owned by `bakeoff.near`. It uses the same rules, evaluator build `e1688636…` and 100-ticket sealed set as the testnet rounds. The evaluator is published at `main.fastfs.io`, and the sealed set and API key are stored on `outlayer.near`, bound to that build and readable only through this challenge.

| Step | Who | Transaction |
|---|---|---|
| Publish the evaluator to FastFS | `bakeoff.near` | [8utnPzBY…](https://nearblocks.io/txns/8utnPzBYaDc3NHqMsDXh2gRvLa1K7YWMAAeJuYzLM3rc) |
| Create the challenge account with 2.5 NEAR | `bakeoff.near` | [FPXGmy75…](https://nearblocks.io/txns/FPXGmy75Pu8XntN62oGZZ6FRurjSuuANpwLQYsVWDieo) |
| Deploy and initialise the contract | challenge account | [D6uHy3gx…](https://nearblocks.io/txns/D6uHy3gxguprUmG8C3pLKB2WVQgaQuiLPd2QbLCJWR25) |
| Store the secrets on OutLayer (0.2446 NEAR deposit) | `bakeoff.near` | [3bfDmZZW…](https://nearblocks.io/txns/3bfDmZZWFwwd2swH3dZtRHffts8WohXBuFf8PDRH6hTv) |
| Owner's trial with the baseline config, while a draft | `bakeoff.near` | [4nCsos2P…](https://nearblocks.io/txns/4nCsos2Piha5frpxucuu9G6RwWWqXDYbgAYRXgoJnYq5) |
| Fund 1 NEAR, signed in the web board through NEAR Connect | `bakeoff.near` | [7JUea7Ty…](https://nearblocks.io/txns/7JUea7TyVHhdaW4Tbg6F1emANkHf3CD24daaEJGYoBYi) |
| Open until 2026-11-09 17:02 UTC, signed in the web board | `bakeoff.near` | [8QxhKE18…](https://nearblocks.io/txns/8QxhKE18jstzVQBuAKtEUp8X1QAY8YWXLZ28nzF3Z9JB) |
| `submit_candidate` from the MCP server, signed by near-cli | `agent.bakeoff.near` | [9PGW15xg…](https://nearblocks.io/txns/9PGW15xgpFqaueAWr9Q6LedH6bvdQWH6aP1njCT22BUy) |

FastFS uploads call a method that does not exist, so explorers list the upload as failed; the indexer serves its arguments as the file. The file served hashes to the pinned `e1688636…`.

| Candidate | Submitter | Outcome | Accuracy | Cost per ticket | p95 latency | Leaks | Invalid answers | Request to verdict |
|---|---|---|---|---|---|---|---|---|
| Baseline, owner's trial | `bakeoff.near` | Failed: cost gate | 85.0% | 126 µ$ | 11.5 s | 0 | 3 | 49.8 s |
| **Agent's candidate** | `agent.bakeoff.near` | **Passed, paid 1 NEAR** | **89.0%** | **51 µ$** | **2.6 s** | 0 | 0 | 18.0 s |

- **How the agent ran.** It ran in a fresh Claude Code session in an empty folder, with the Bakeoff MCP server on mainnet as its only Bakeoff source. It worked from the challenge rules, the labeling guide, the practice tickets and practice scores from the pinned evaluator. This was its first and only sealed submission.
- **Against the baseline.** The agent is 60% cheaper per ticket than the sponsor's baseline (51 µ$ against 126 µ$ in the trial and 128 µ$ in calibration). Its p95 latency is about a seventh of the gate, and it is more accurate than both the trial (85.0%) and the calibrated median (87.0%).
- **The config.** It was recovered from the submission's arguments, and its SHA-256 equals the verdict's `config_sha256`, `aedee340…`. It is saved byte for byte as `examples/candidates/near-ai/agent-mainnet.json`. It uses the same model and settings as the testnet agent's winner (`z-ai/glm-5.3-flash`, `reasoning_effort` low, no examples), with its own 1,287-character prompt and `max_tokens` 150.
- **Payment.** The contract paid the award in the verdict's callback, and `agent.bakeoff.near` went from 0.5 to 1.486 NEAR. Its submission cost 0.0139 NEAR: the 0.035 NEAR deposit less OutLayer's refund, plus gas.
- **Costs.** `bakeoff.near` was funded with 5.18 NEAR. After the round the three accounts hold 4.906 NEAR, so the round used 0.274 NEAR:
  - 0.2446 NEAR is the OutLayer storage deposit for the secrets;
  - everything else came to under 0.03 NEAR in fees.

  The challenge account's 2.5 NEAR mostly pays for the contract's 188 KB of storage. Deleting the account returns it.
- **Accounts.** The project's author controls both `bakeoff.near` and `agent.bakeoff.near`. The contract pays any account other than its owner. This round shows the whole flow working on mainnet, not a contest between unrelated parties.
- **Operational notes.**
  - near.org's public mainnet RPC answered HTTP 429 during the deploy. The scripts, the MCP server and near-cli now use FastNEAR, and a deploy that stops after creating its account resumes into it.
  - Ad blockers' cosmetic filters hid the web board's funding controls, because of class names such as `sponsor-block`. Those classes are renamed.

## Shared contract on testnet (2026-11-17)

The challenge contract the board serves (`web/public/contract/bakeoff_contract.wasm`, 186,518 bytes, code hash `HeXPDJmQgPDfBfYvedbTL3iVyFvX7yZ84NH3s5n3tTGU`) is published on testnet as a NEAR global contract by hash, from `finishr.testnet`, with `scripts/near/publish-shared-contract.sh` and near-cli-rs 0.31.1: transaction `EKgccR1AwGWt7UVJDRBWV8P52R4gBq9krUxzGDZc2vTm`. It burned 18.653 testnet NEAR, ten times the normal storage rate for its size, as NEP-591 sets. The 16 testnet NEAR it needed beyond `finishr.testnet`'s balance came from two faucet accounts, `bakeoff-faucet-1-20261117.testnet` and `bakeoff-faucet-2-20261117.testnet`.

Testnet challenges deployed from the setup form now reference it, and need about 0.06 NEAR of storage instead of 1.9. Nothing is published on mainnet, where the same step would burn about 18.6 NEAR.
