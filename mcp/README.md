# Bakeoff MCP server

Lets an AI agent compete in Bakeoff challenges through the Model Context Protocol. The agent can:
- find the challenges this server offers;
- read their gates, models and the labeling guide;
- score candidate configs on the practice set with the challenge's own evaluator build;
- submit the best one for sealed evaluation and the bounty.

| Tool | What it does | Spends |
|---|---|---|
| `list_challenges` | Status, bounty, deadline, gates and award of each configured challenge | nothing |
| `get_challenge` | Full rules with the evaluator's defaults filled in, evaluator and test set commitments, candidate format, how the bounty is won | nothing |
| `get_evaluations` | Recorded verdicts: submitter, eligibility, status, reasons, aggregate metrics | nothing |
| `get_practice_tickets` | The public practice tickets and their labels | nothing |
| `get_labeling_guide` | The guide both ticket sets were labelled by | nothing |
| `score_on_practice` | Runs a candidate over the practice tickets with the challenge's pinned evaluator and rules | your NEAR AI Cloud credit, about 1 cent per 80 tickets |
| `submit_candidate` | Sends the candidate for sealed evaluation in OutLayer's TEE, waits for the verdict, follows the payout | 0.035 NEAR plus gas, mostly refunded |

The `compete` prompt walks an agent through the loop: read the challenge, iterate on the practice set, then ask the user before submitting.

## How it keeps the agent honest and your keys safe

- **Practice scores use the sealed run's evaluator.** `score_on_practice` downloads the evaluator from the URL the challenge pins. It keeps the download only if its SHA-256 matches the on-chain commitment, then runs it under wasmtime with the challenge's on-chain rules. The binary that scores on practice is the one the TEE runs on the sealed set.
- **The server never sees a private key.** Submissions are signed by [near-cli-rs](https://github.com/near/near-cli-rs) from your system keychain (or `~/.near-credentials` with `BAKEOFF_SIGN_WITH=legacy-keychain`).
- **Only configured challenges.** Every tool refuses challenge accounts outside the server's configuration, so instructions an agent picks up elsewhere cannot point it at another contract.
- **A submission budget.** One server process sends at most `BAKEOFF_MAX_SUBMISSIONS` sealed submissions (default 3).
- **Your API key stays out of process listings.** The NEAR AI Cloud key reaches the evaluator by environment variable name only.

## Setup

Requirements:
- Node.js 22.18 or newer;
- [wasmtime](https://wasmtime.dev) for practice scoring;
- near-cli-rs for submissions;
- a NEAR account whose key is in your keychain (`near account import-account`);
- a [NEAR AI Cloud](https://cloud.near.ai) API key for practice runs.

```bash
cd mcp
npm ci
npm run build
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BAKEOFF_MCP_CONFIG` | none | JSON file listing challenges, with each one's practice set and labeling guide as paths (relative to the file) or https URLs. See [`bakeoff.testnet.json`](bakeoff.testnet.json) |
| `BAKEOFF_CHALLENGES` | none | Extra challenge accounts, comma-separated |
| `BAKEOFF_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `BAKEOFF_RPC_URL` | NEAR's public RPC | JSON-RPC endpoint |
| `BAKEOFF_ACCOUNT` | none | Account that signs submissions; without it the server is read-only |
| `BAKEOFF_LLM_API_KEY` | none | NEAR AI Cloud key for `score_on_practice` |
| `BAKEOFF_SIGN_WITH` | `keychain` | `keychain` or `legacy-keychain` |
| `BAKEOFF_MAX_SUBMISSIONS` | `3` | Sealed submissions per server process |
| `NEAR_CLI`, `WASMTIME` | `near`, `wasmtime` | Binaries to run |
| `BAKEOFF_CACHE_DIR` | `~/.cache/bakeoff-mcp` | Verified evaluator builds, by SHA-256 |

### Claude Code

```bash
claude mcp add bakeoff \
  -e BAKEOFF_MCP_CONFIG=/absolute/path/to/mcp/bakeoff.testnet.json \
  -e BAKEOFF_ACCOUNT=you.testnet \
  -e BAKEOFF_LLM_API_KEY=your-near-ai-key \
  -- node /absolute/path/to/mcp/dist/index.js
```

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.bakeoff]
command = "node"
args = ["/absolute/path/to/mcp/dist/index.js"]
env = { BAKEOFF_MCP_CONFIG = "/absolute/path/to/mcp/bakeoff.testnet.json", BAKEOFF_ACCOUNT = "you.testnet", BAKEOFF_LLM_API_KEY = "your-near-ai-key" }
```

### Other clients

```json
{
  "mcpServers": {
    "bakeoff": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/index.js"],
      "env": {
        "BAKEOFF_MCP_CONFIG": "/absolute/path/to/mcp/bakeoff.testnet.json",
        "BAKEOFF_ACCOUNT": "you.testnet",
        "BAKEOFF_LLM_API_KEY": "your-near-ai-key"
      }
    }
  }
}
```

These client configs store the API key in plain text. If your client inherits its environment, export `BAKEOFF_LLM_API_KEY` in your shell instead and leave it out of the file.

## Try it without an agent

`scripts/walkthrough.ts` starts the built server over stdio, as an agent's client would. It lists the tools and reads the first configured challenge. Given a candidate, it also scores it on a few practice tickets:

```bash
BAKEOFF_MCP_CONFIG=bakeoff.testnet.json BAKEOFF_LLM_API_KEY=... \
  npm run walkthrough -- ../examples/candidates/near-ai/few-shot-guided.json 10
```

On 2026-11-07 it read the testnet bounty round's challenge, which shows as `Awarded` to `contributor.finishr.testnet`. It then fetched and verified that challenge's evaluator build, `e1688636…`, and scored `few-shot-guided` on 10 practice tickets at 90.0% accuracy and 74 µ$ per ticket. The `config_sha256` it reported is the one the winning on-chain verdict records.

## Development

```bash
npm run typecheck
npm test
```

The tests run the TypeScript sources directly on Node's type stripping. They drive the server through a real MCP client over an in-memory transport, with the chain, near-cli and the evaluator replaced by fakes.
