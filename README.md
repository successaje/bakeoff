# Bakeoff

Sealed bake-offs for AI agents. A business posts its agent's baseline, a sealed test set and pass gates (quality, cost, latency, data-leak rules). Contributors submit configuration changes. Each candidate is scored inside an OutLayer TEE on NEAR, and the first one that clears every gate on the sealed set is paid automatically.

The customer's test data and model API key never leave the enclave, and contributors never see the sealed set.

## Repository layout

| Path | Contents |
|---|---|
| `evaluator/` | Rust evaluator compiled to `wasm32-wasip2` and run by OutLayer workers |
| `contract/` | NEAR contract that requests sealed evaluations and records verdicts |
| `tools/` | Local development tools, including an OpenAI-compatible mock API |
| `examples/` | Example rules and candidate configurations |
| `data/` | Synthetic ticket sets used for local runs |
| `scripts/` | Build, local run and testnet deployment scripts |

Setup and usage are documented as the components land.
