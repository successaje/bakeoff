/**
 * Drives the built server over stdio, as an agent's MCP client would:
 * lists its tools, reads the first configured challenge, and, given a
 * candidate file, scores it on a few practice tickets.
 *
 * Usage: node scripts/walkthrough.ts [candidate.json] [tickets]
 * Reads BAKEOFF_MCP_CONFIG and the other settings from the environment.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [candidatePath, tickets = "10"] = process.argv.slice(2);
const client = new Client({ name: "bakeoff-walkthrough", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: process.env as Record<string, string>,
    stderr: "inherit",
  }),
);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
const { network, challenges } = await call("list_challenges");
console.log(`\n${network} challenges:`);
console.log(JSON.stringify(challenges, null, 2));

const id = challenges[0]?.id;
if (id) {
  const challenge = await call("get_challenge", { challenge_id: id });
  console.log(`\n${id}: ${challenge.practice_tickets} practice tickets, evaluator ${challenge.evaluator.sha256.slice(0, 12)}…, models ${Object.keys(challenge.rules.models).join(", ")}`);
  if (candidatePath) {
    const score = await call("score_on_practice", {
      challenge_id: id,
      config_json: readFileSync(candidatePath, "utf8"),
      ticket_limit: Number(tickets),
    });
    console.log(`\npractice score on ${score.tickets} tickets:`);
    console.log(JSON.stringify({ passed: score.passed, reasons: score.reasons, metrics: score.metrics, config_sha256: score.config_sha256 }, null, 2));
  }
}
await client.close();
