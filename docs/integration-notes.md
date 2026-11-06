# Integration notes

Findings from building against OutLayer and NEAR AI Cloud. They were checked against OutLayer's contract source (`out-layer/outlayer`, `contract/src/execution.rs`, `lib.rs`) and CLI 0.2.1, and against live RPC and API responses on 2026-11-07.

## OutLayer

**Execution requests**
- `request_execution` runs nothing unless `resource_limits` is present. Without it the request is compile-only. The contract always sends explicit limits.
- With `response_format: "Json"`, the calling contract's callback receives the evaluator's stdout as raw JSON bytes, or `null` when the run failed. The contract reads it with `promise_result_checked`, bounded to 4 KiB.

**Secrets and who may read them**
- Secret access is judged against the transaction signer, not the calling contract. Restricting reads to the challenge contract therefore needs the predecessor rule. With the CLI that is `outlayer secrets set … --wasm-hash <evaluator sha256> --access allow-all --via <challenge>`. `--via` on its own admits only calls that come through the named contract.
- Secrets bound with `--wasm-hash` are sealed to that exact binary. Rebuilding the evaluator means storing the secrets again for the new hash, and calling `set_evaluator` while the challenge is a draft.

**Cost**
- `estimate_execution_cost` returns 0.0190001 NEAR on both testnet and mainnet for 1B instructions, 128 MB and 180 s. Time dominates: 30 s costs about 0.004 NEAR.
- Unused deposit is refunded to `payer_account_id`, which the contract sets to the submitter.

## WASI HTTP

- `wasi-http-client` 0.2.1, which OutLayer's AI example uses, writes the whole request body with a single `blocking-write-and-flush`. WASI caps that call at 4096 bytes, and a prompt with examples exceeds it. `evaluator/src/wasi_http.rs` writes in 4 KiB chunks.
- Without an explicit `Content-Length` the host sends the body chunked, which some servers reject. The client always sets it.
- The client sets connect, first-byte and between-bytes timeouts. Whether OutLayer's worker honours all three is unverified.

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

## Still to confirm on testnet

1. A full round trip: contract → OutLayer → evaluator → NEAR AI → verdict recorded, with its wall-clock time.
2. How many tickets fit in the 180-second limit with real model latency inside the TEE.
3. Whether a secret value of several KB, the sealed test set as one environment variable, is accepted. If not, move the test set to encrypted storage and keep only its key as a secret.
4. Whether reasoning-capable models spend `max_tokens` on reasoning and return empty content at the configured limit.
