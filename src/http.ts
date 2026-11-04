/**
 * Streamable HTTP transport (stateless) plus a tiny admin API for approvals.
 *
 *   POST /mcp                      agent traffic, `Authorization: Bearer $MCP_HTTP_TOKEN`
 *   GET  /proposals                admin,         `Authorization: Bearer $MCP_ADMIN_TOKEN`
 *   POST /proposals/:id/approve    admin
 *   POST /proposals/:id/reject     admin
 *   GET  /healthz
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { Config } from "./config.js";
import { ProposalStore } from "./proposals.js";
import { createServer } from "./server.js";

function bearerOk(req: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return false;
  const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export function createHttpApp(config: Config): Server {
  if (!config.httpToken) throw new Error("MCP_HTTP_TOKEN is required for the HTTP transport");
  const proposals = new ProposalStore(config.proposalsFile);

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") return json(res, 200, { status: "ok" });

      if (url.pathname === "/mcp") {
        if (!bearerOk(req, config.httpToken)) return json(res, 401, { error: "unauthorized" });
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed; stateless server accepts POST only" });
        const server = createServer({ config, proposals });
        const transport = new StreamableHTTPServerTransport({});
        res.on("close", () => void transport.close().then(() => server.close()));
        await server.connect(transport);
        return transport.handleRequest(req, res, await readBody(req));
      }

      const m = url.pathname.match(/^\/proposals(?:\/([^/]+)\/(approve|reject))?$/);
      if (m) {
        if (!bearerOk(req, config.adminToken)) return json(res, 401, { error: "unauthorized (admin token)" });
        if (!m[1]) return json(res, 200, { items: proposals.list(url.searchParams.get("status") as never) });
        if (req.method !== "POST") return json(res, 405, { error: "POST required" });
        const by = (req.headers["x-approver"] as string | undefined) ?? "http-admin";
        return json(res, 200, proposals.decide(m[1], m[2] === "approve" ? "approved" : "rejected", by));
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  });
}
