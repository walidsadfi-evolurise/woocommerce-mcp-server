#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { userInfo } from "node:os";

import { configFromEnv } from "./config.js";
import { createHttpApp } from "./http.js";
import { ProposalStore } from "./proposals.js";
import { createServer } from "./server.js";

const USAGE = `woocommerce-mcp-server — MCP server for WooCommerce with a human approval gate

Usage:
  woocommerce-mcp-server                  start on stdio (for Claude Desktop, Cursor, …)
  woocommerce-mcp-server http [--port N]  start the Streamable HTTP transport (default 3333)
  woocommerce-mcp-server proposals        list proposals waiting for review
  woocommerce-mcp-server approve <id>     approve a proposal (id prefix is enough)
  woocommerce-mcp-server reject <id>      reject a proposal

Environment:
  WOO_URL, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET   required
  WOO_ALLOW_WRITES=false   allow apply_proposal (default: read-only)
  WOO_REDACT_PII=true      mask customer emails/phones/addresses
  WOO_PROPOSALS_FILE       default .woo-proposals.json
  MCP_HTTP_TOKEN           bearer token for /mcp (http mode)
  MCP_ADMIN_TOKEN          bearer token for /proposals (must differ from MCP_HTTP_TOKEN)
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(USAGE);
    return;
  }
  const config = configFromEnv();

  if (cmd === "proposals" || cmd === "approve" || cmd === "reject") {
    const store = new ProposalStore(config.proposalsFile);
    if (cmd === "proposals") {
      const items = store.list(rest[0] as never);
      if (!items.length) return void console.log("No proposals.");
      for (const p of items) console.log(`${p.id.slice(0, 8)}  ${p.status.padEnd(8)}  ${p.kind.padEnd(13)}  ${p.summary}\n          reason: ${p.reason}`);
      return;
    }
    const id = rest[0];
    if (!id) throw new Error(`Usage: woocommerce-mcp-server ${cmd} <proposal-id>`);
    const p = store.decide(id, cmd === "approve" ? "approved" : "rejected", userInfo().username);
    console.log(`${p.status}: ${p.summary}`);
    return;
  }

  if (cmd === "http") {
    const portIdx = rest.indexOf("--port");
    const port = portIdx >= 0 ? Number(rest[portIdx + 1]) : Number(process.env.PORT ?? 3333);
    const app = createHttpApp(config);
    app.listen(port, () => console.error(`woocommerce-mcp-server listening on :${port} (writes ${config.allowWrites ? "ENABLED" : "disabled"})`));
    return;
  }

  if (cmd !== undefined) throw new Error(`Unknown command "${cmd}".\n\n${USAGE}`);
  const server = createServer({ config });
  await server.connect(new StdioServerTransport());
  console.error(`woocommerce-mcp-server on stdio → ${config.url} (writes ${config.allowWrites ? "ENABLED" : "disabled"}, PII ${config.redactPii ? "masked" : "VISIBLE"})`);
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
