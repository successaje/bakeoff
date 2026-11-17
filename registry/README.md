# Listing registry

A NEAR contract where owners list their challenges on the board themselves, without a pull request to [`web/public/challenges.json`](../web/public/challenges.json).

A challenge contract holds its rules, commitments, results and reward. What the board shows about it besides, a title, the team setting the goal, the task in their words and the baseline, is a listing. The registry holds listings on-chain.

## Who can list

Only the account a challenge was created under. Challenge accounts are sub-accounts of their owner (`<name>.<owner>`), whether deployed from the board's setup form or with `scripts/near/deploy.sh`, and only an account can create its own sub-accounts. So the caller must be the challenge's parent account, and the registry needs no call to the challenge to check it. A grandparent account cannot list either.

## Interface

| Method | Kind | What it does |
|---|---|---|
| `new()` | init | Creates an empty registry |
| `list(challenge, listing)` | call, payable | Lists `challenge`, or replaces its listing. Attach enough for the listing's storage (0.05 NEAR is plenty); the rest is refunded |
| `unlist(challenge)` | call | Removes the listing and refunds the storage it held. The challenge itself is untouched |
| `get_listing(challenge)` | view | The listing with its owner and last update, or null |
| `get_listings(from_index?, limit?)` | view | Listings in the order they were first made, at most 100 a page |
| `listing_count()` | view | How many challenges are listed |

A listing has the fields of a `challenges.json` entry: `title`, `sponsor`, `summary`, `problem`, `tags`, `tickets`, `baseline` (`accuracy_bp`, `cost_per_ticket_uusd`, `p95_latency_ms`), `baseline_config_sha256`, `practice_set` and `labeling_guide`. The registry checks them before storing: text is non-empty and bounded (title 120 characters, summary 600, problem 2,000, at most 8 tags of 40), `tickets` is 1 to 100,000, accuracy is at most 10,000 basis points, the config hash is 64 lowercase hex characters, and both links are https.

Every change is logged as a NEP-297 event, `{"standard": "bakeoff_registry", "event": "listed" | "unlisted", "data": [{ "challenge", "owner" }]}`.

## How the board uses it

The board reads the registry for each network named in `LISTING_REGISTRY` in [`web/src/lib/registry.ts`](../web/src/lib/registry.ts) and adds its listings to those in `challenges.json`, which wins when both list a challenge. It shows a self-listed challenge only if the account runs a known build of the Bakeoff challenge contract, by code hash, so a listing cannot pass off another contract as a challenge. Self-listed challenges carry a Self-listed badge: Bakeoff has not reviewed them, while their rules, results and reward are the contract's as for any challenge. A registry that cannot be read leaves the board as it is.

The setup form's Listing tab writes the arguments (`list-args.json`) and the near-cli command once a registry is configured for the challenge's network.

## Deploying

```bash
NETWORK=testnet BAKEOFF_ACCOUNT=you.testnet scripts/near/deploy-registry.sh
```

It builds the contract (cargo-near 0.13+), creates `registry.<account>`, deploys and initialises it, then prints the line to add to `LISTING_REGISTRY`. On mainnet it asks for `MAINNET_CONFIRM`, like every script that spends.

## Tests

`cargo test -p bakeoff-registry` covers who may list, the checks and paging. The sandbox test in [`integration-tests/tests/registry.rs`](../integration-tests/tests/registry.rs), run by `scripts/test-sandbox.sh`, covers storage and refunds on a local NEAR node.
