import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createHttpApp } from "../src/http.js";
import { testConfig } from "./helpers.js";
import { startMockWoo, type MockWoo } from "./mock-woo.js";

let woo: MockWoo;
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  woo = await startMockWoo();
  const app = createHttpApp(testConfig(woo.url, { httpToken: "agent-token", adminToken: "admin-token" }));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  close = () => new Promise((r) => app.close(() => r()));
});
afterAll(async () => {
  await close();
  await woo.close();
});

describe("http transport", () => {
  it("rejects agents without the bearer token", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("serves MCP over Streamable HTTP and the admin API approves proposals", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer agent-token" } } }));
    const r = await client.callTool({ name: "propose_order_note", arguments: { order_id: 500, note: "hi", reason: "Testing the gate" } });
    const { proposal_id } = JSON.parse((r.content as { text: string }[])[0]!.text) as { proposal_id: string };

    // the agent token must not be able to approve
    expect((await fetch(`${base}/proposals/${proposal_id}/approve`, { method: "POST", headers: { authorization: "Bearer agent-token" } })).status).toBe(401);
    const ok = await fetch(`${base}/proposals/${proposal_id}/approve`, { method: "POST", headers: { authorization: "Bearer admin-token", "x-approver": "walid" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "approved", decidedBy: "walid" });

    const list = await fetch(`${base}/proposals?status=approved`, { headers: { authorization: "Bearer admin-token" } });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
    await client.close();
  });
});
