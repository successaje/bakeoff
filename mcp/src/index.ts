#!/usr/bin/env node
/**
 * Bakeoff MCP server over stdio. With no configuration it serves the challenges
 * the Bakeoff board lists for BAKEOFF_NETWORK; the README describes the
 * environment variables. Logs go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config.ts";
import { createServer, defaultDeps } from "./server.ts";
import { runCli } from "./submit.ts";

const config = await resolveConfig();
const server = createServer(config, defaultDeps(config, runCli));
await server.connect(new StdioServerTransport());
process.stderr.write(
  `bakeoff-mcp on ${config.network}: ${config.challenges.length} challenge(s) from ${config.source}, ` +
    `${config.account ? `submitting as ${config.account}` : "read-only (no BAKEOFF_ACCOUNT)"}\n`,
);
