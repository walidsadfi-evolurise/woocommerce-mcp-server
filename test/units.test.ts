import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configFromEnv } from "../src/config.js";
import { ProposalStore } from "../src/proposals.js";
import { maskEmail, maskPhone, redact } from "../src/redact.js";
import { WooClient, WooError } from "../src/woo-client.js";
import { startMockWoo, type MockWoo } from "./mock-woo.js";

describe("redact", () => {
  it("masks emails, phones and names, drops street lines", () => {
    expect(maskEmail("marie.dupont@example.com")).toBe("m***@example.com");
    expect(maskEmail("garbage")).toBe("***");
    expect(maskPhone("+33 6 12 34 56 78")).toBe("***78");
    const out = redact({ billing: { email: "a@b.c", address_1: "x", city: "Lyon", first_name: "Marie" }, line_items: [{ name: "Cap" }] });
    expect(out).toEqual({ billing: { email: "a***@b.c", city: "Lyon", first_name: "M." }, line_items: [{ name: "Cap" }] });
  });
});

describe("config", () => {
  const env = { WOO_URL: "https://shop.test", WOO_CONSUMER_KEY: "ck", WOO_CONSUMER_SECRET: "cs" };
  it("defaults to read-only with PII masked", () => {
    const c = configFromEnv(env);
    expect(c.allowWrites).toBe(false);
    expect(c.redactPii).toBe(true);
    expect(configFromEnv({ ...env, WOO_ALLOW_WRITES: "true", WOO_REDACT_PII: "0" })).toMatchObject({ allowWrites: true, redactPii: false });
  });
  it("names the missing variables", () => {
    expect(() => configFromEnv({})).toThrow(/WOO_URL/);
  });
  it("refuses identical agent and admin tokens", () => {
    expect(() => configFromEnv({ ...env, MCP_HTTP_TOKEN: "same", MCP_ADMIN_TOKEN: "same" })).toThrow(/must differ/);
  });
});

describe("ProposalStore", () => {
  const file = join(mkdtempSync(join(tmpdir(), "props-")), "p.json");
  it("persists across instances and resolves id prefixes", () => {
    const a = new ProposalStore(file);
    const p = a.create({ kind: "order_note", summary: "s", reason: "r", payload: {} });
    const b = new ProposalStore(file);
    expect(b.get(p.id.slice(0, 8))?.id).toBe(p.id);
    b.decide(p.id.slice(0, 8), "approved", "me");
    expect(a.get(p.id)?.status).toBe("approved");
    expect(() => a.decide(p.id, "rejected", "me")).toThrow(/already approved/);
    expect(() => a.decide("nope", "approved", "me")).toThrow(/Unknown/);
  });
});

describe("WooClient", () => {
  let woo: MockWoo;
  beforeAll(async () => {
    woo = await startMockWoo({ requireAuth: true });
  });
  afterAll(() => woo.close());

  it("uses query-string auth over plain http and reads pagination headers", async () => {
    const c = new WooClient({ url: woo.url + "/", consumerKey: "ck", consumerSecret: "cs" });
    const page = await c.getPage("products", { per_page: 2 });
    expect(page.total).toBe(3);
    expect(page.totalPages).toBe(2);
    expect(woo.authSeen.query).toBe(true);
    expect(woo.authSeen.basic).toBe(false);
  });

  it("turns WooCommerce error payloads into WooError with code and status", async () => {
    const c = new WooClient({ url: woo.url, consumerKey: "ck", consumerSecret: "cs" });
    const err = await c.get("orders/1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WooError);
    expect((err as WooError).status).toBe(404);
    expect((err as WooError).code).toBe("woocommerce_rest_shop_order_invalid_id");
  });

  it("explains non-JSON responses and network failures", async () => {
    const c = new WooClient({ url: woo.url, consumerKey: "ck", consumerSecret: "cs" });
    await expect(c.get("broken")).rejects.toThrow(/Is this a WooCommerce site/);
    const dead = new WooClient({ url: "http://127.0.0.1:9", consumerKey: "ck", consumerSecret: "cs", timeoutMs: 2000 });
    await expect(dead.get("products")).rejects.toThrow(/Network error/);
  });

  it("sends Basic auth over https", async () => {
    let seen = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      seen = String((init?.headers as Record<string, string>).authorization);
      return new Response("[]", { headers: { "content-type": "application/json" } });
    };
    const c = new WooClient({ url: "https://shop.test", consumerKey: "ck", consumerSecret: "cs", fetchImpl });
    await c.get("products");
    expect(seen).toBe("Basic " + Buffer.from("ck:cs").toString("base64"));
  });
});
