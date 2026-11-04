import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigSchema, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { ProposalStore } from "../src/proposals.js";

export function testConfig(url: string, over: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), "woo-mcp-"));
  return ConfigSchema.parse({ url, consumerKey: "ck_test", consumerSecret: "cs_test", proposalsFile: join(dir, "proposals.json"), ...over });
}

export async function connect(config: Config) {
  const server = createServer({ config });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[]).find((c) => c.type === "text")?.text ?? "";
    return { isError: Boolean(res.isError), text, data: res.isError ? undefined : (JSON.parse(text) as Record<string, any>) }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { client, server, call, proposals: new ProposalStore(config.proposalsFile), close: () => Promise.all([client.close(), server.close()]) };
}
