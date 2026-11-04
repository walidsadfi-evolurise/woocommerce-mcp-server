import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect, testConfig } from "./helpers.js";
import { startMockWoo, type MockWoo } from "./mock-woo.js";

let woo: MockWoo;
beforeAll(async () => {
  woo = await startMockWoo();
});
afterAll(() => woo.close());

describe("read tools", () => {
  it("lists every tool with annotations", async () => {
    const c = await connect(testConfig(woo.url));
    const { tools } = await c.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "apply_proposal", "get_order", "get_product", "list_orders", "list_products", "list_proposals", "low_stock_products",
      "propose_order_note", "propose_order_status", "propose_price_update", "propose_refund", "propose_stock_update",
      "sales_summary", "search_customers", "store_info",
    ]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).toContain("list_orders");
    expect(readOnly).not.toContain("apply_proposal");
    await c.close();
  });

  it("store_info merges system status and enabled gateways", async () => {
    const c = await connect(testConfig(woo.url));
    const r = await c.call("store_info");
    expect(r.data).toMatchObject({ wc_version: "9.9.0", currency: "EUR", payment_gateways: ["Card (Stripe)"] });
    await c.close();
  });

  it("list_products paginates and forwards filters", async () => {
    const c = await connect(testConfig(woo.url));
    const r = await c.call("list_products", { search: "hoodie", per_page: 5 });
    expect(r.data!.total).toBe(1);
    expect(r.data!.items[0].sku).toBe("HOOD-BLU");
    const last = woo.requests.at(-1)!;
    expect(last.query).toMatchObject({ search: "hoodie", per_page: "5", page: "1", status: "publish" });
    expect(last.query._fields).toContain("stock_quantity");
    await c.close();
  });

  it("get_product by sku includes variations for variable products", async () => {
    const c = await connect(testConfig(woo.url));
    expect((await c.call("get_product", { sku: "TEE" })).data!.variations[0].sku).toBe("TEE-S");
    expect((await c.call("get_product", { id: 10 })).data!.variations).toBeUndefined();
    const miss = await c.call("get_product", { id: 999 });
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain("woocommerce_rest_product_invalid_id");
    await c.close();
  });

  it("low_stock_products uses the product's own threshold first", async () => {
    const c = await connect(testConfig(woo.url));
    const r = await c.call("low_stock_products", { threshold: 50 });
    // Hoodie: qty 3 <= own low_stock_amount 5 → low. Cap: qty 40 <= threshold 50 → low. Tee: unmanaged → skipped.
    expect(r.data!.items.map((p: { sku: string }) => p.sku)).toEqual(["HOOD-BLU", "CAP-RED"]);
    const r2 = await c.call("low_stock_products", { threshold: 5 });
    expect(r2.data!.items.map((p: { sku: string }) => p.sku)).toEqual(["HOOD-BLU"]);
    await c.close();
  });

  it("get_order attaches notes and masks PII by default", async () => {
    const c = await connect(testConfig(woo.url));
    const r = await c.call("get_order", { id: 500 });
    const o = r.data!;
    expect(o.notes[0].note).toBe("Payment received");
    expect(o.billing.email).toBe("m***@example.com");
    expect(o.billing.phone).toBe("***78");
    expect(o.billing.first_name).toBe("M.");
    expect(o.billing.address_1).toBeUndefined();
    expect(o.billing.city).toBe("Lyon");
    expect(o.customer_ip_address).toBeUndefined();
    expect(o.transaction_id).toBeUndefined();
    expect(JSON.stringify(o)).not.toContain("rue des Lilas");
    await c.close();
  });

  it("returns full PII when redaction is disabled by the operator", async () => {
    const c = await connect(testConfig(woo.url, { redactPii: false }));
    const r = await c.call("search_customers", { search: "dupont" });
    expect(r.data!.items[0].email).toBe("marie.dupont@example.com");
    await c.close();
  });

  it("sales_summary flattens the report", async () => {
    const c = await connect(testConfig(woo.url));
    const r = await c.call("sales_summary", { period: "month" });
    expect(r.data).toMatchObject({ period: "month", total_sales: "1234.50", total_orders: 18 });
    await c.close();
  });

  it("validates input before hitting the store", async () => {
    const c = await connect(testConfig(woo.url));
    const before = woo.requests.length;
    const r = await c.call("list_orders", { status: "bogus" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Invalid enum value/);
    expect(woo.requests.length).toBe(before);
    await c.close();
  });
});

describe("proposal gate", () => {
  it("proposals are recorded but cannot be applied on a read-only server", async () => {
    const c = await connect(testConfig(woo.url));
    const p = await c.call("propose_order_status", { order_id: 500, status: "completed", reason: "Parcel delivered per carrier tracking" });
    expect(p.data!.status).toBe("pending");
    expect(p.data!.next_step).toContain("read-only");
    const writesBefore = woo.requests.filter((r) => r.method !== "GET").length;
    c.proposals.decide(p.data!.proposal_id, "approved", "tester");
    const applied = await c.call("apply_proposal", { proposal_id: p.data!.proposal_id });
    expect(applied.isError).toBe(true);
    expect(applied.text).toContain("read-only");
    expect(woo.requests.filter((r) => r.method !== "GET").length).toBe(writesBefore);
    await c.close();
  });

  it("pending and rejected proposals cannot be applied even with writes enabled", async () => {
    const c = await connect(testConfig(woo.url, { allowWrites: true }));
    const p = await c.call("propose_order_note", { order_id: 500, note: "Customer called", reason: "Keep a trace of the call" });
    const id = p.data!.proposal_id as string;
    expect((await c.call("apply_proposal", { proposal_id: id })).text).toContain("is pending");
    c.proposals.decide(id, "rejected", "tester");
    expect((await c.call("apply_proposal", { proposal_id: id })).text).toContain("is rejected");
    expect(woo.requests.some((r) => r.method === "POST" && r.path === "orders/500/notes")).toBe(false);
    await c.close();
  });

  it("an approved proposal is executed exactly once and recorded", async () => {
    const c = await connect(testConfig(woo.url, { allowWrites: true }));
    const p = await c.call("propose_stock_update", { product_id: 12, variation_id: 120, stock_quantity: 0, reason: "Supplier discontinued size S" });
    const id = p.data!.proposal_id as string;
    c.proposals.decide(id, "approved", "tester");
    const applied = await c.call("apply_proposal", { proposal_id: id });
    expect(applied.isError).toBe(false);
    expect(applied.data!.proposal.status).toBe("applied");
    const put = woo.requests.find((r) => r.method === "PUT" && r.path === "products/12/variations/120");
    expect(put?.body).toEqual({ manage_stock: true, stock_quantity: 0 });
    // second apply is refused: status is now "applied"
    expect((await c.call("apply_proposal", { proposal_id: id })).text).toContain("is applied");
    expect(c.proposals.list("applied")).toHaveLength(1);
    await c.close();
  });

  it("refund and price proposals map to the right endpoints", async () => {
    const c = await connect(testConfig(woo.url, { allowWrites: true }));
    const refund = await c.call("propose_refund", { order_id: 500, amount: "19.00", refund_reason: "Cap arrived damaged", reason: "Photo received from customer" });
    const price = await c.call("propose_price_update", { product_id: 11, sale_price: "15.00", reason: "Clearance before new collection" });
    for (const r of [refund, price]) c.proposals.decide(r.data!.proposal_id, "approved", "tester");
    await c.call("apply_proposal", { proposal_id: refund.data!.proposal_id });
    await c.call("apply_proposal", { proposal_id: price.data!.proposal_id });
    expect(woo.requests.find((r) => r.path === "orders/500/refunds")?.body).toEqual({ amount: "19.00", reason: "Cap arrived damaged", api_refund: false });
    expect(woo.requests.find((r) => r.method === "PUT" && r.path === "products/11")?.body).toEqual({ sale_price: "15.00" });
    await c.close();
  });

  it("a failed execution marks the proposal failed", async () => {
    const c = await connect(testConfig(woo.url, { allowWrites: true }));
    const p = await c.call("propose_order_status", { order_id: 404404, status: "cancelled", reason: "Duplicate order" });
    c.proposals.decide(p.data!.proposal_id, "approved", "tester");
    const r = await c.call("apply_proposal", { proposal_id: p.data!.proposal_id });
    expect(r.isError).toBe(true);
    expect(c.proposals.get(p.data!.proposal_id)?.status).toBe("failed");
    await c.close();
  });

  it("price proposal requires at least one price", async () => {
    const c = await connect(testConfig(woo.url));
    const r = await c.call("propose_price_update", { product_id: 11, reason: "nothing to change" });
    expect(r.isError).toBe(true);
    await c.close();
  });
});
