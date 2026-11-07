#!/usr/bin/env node
/**
 * Bakeoff MCP server over stdio. Configure with BAKEOFF_MCP_CONFIG and the
 * environment variables described in the README; logs go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { createServer, defaultDeps } from "./server.ts";
import { runCli } from "./submit.ts";

const config = loadConfig();
const server = createServer(config, defaultDeps(config, runCli));
await server.connect(new StdioServerTransport());
process.stderr.write(
  `bakeoff-mcp on ${config.network}: ${config.challenges.length} challenge(s), ` +
    `${config.account ? `submitting as ${config.account}` : "read-only (no BAKEOFF_ACCOUNT)"}\n`,
);
