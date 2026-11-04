import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "./config.js";
import { ProposalStore, type Proposal, type ProposalKind } from "./proposals.js";
import { redact } from "./redact.js";
import { WooClient, WooError } from "./woo-client.js";

export interface ServerDeps {
  config: Config;
  client?: WooClient;
  proposals?: ProposalStore;
}

type Json = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- WooCommerce payloads are open-ended
type AnyJson = Record<string, any>;

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(data: unknown): ToolResult {
  const structured = (data && typeof data === "object" && !Array.isArray(data) ? data : { result: data }) as Json;
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: structured };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof WooError ? `${err.message}${err.code ? ` (${err.code})` : ""}` : (err as Error).message;
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const PRODUCT_FIELDS = "id,name,slug,sku,type,status,price,regular_price,sale_price,on_sale,stock_status,stock_quantity,manage_stock,low_stock_amount,categories,permalink,date_modified";
const ORDER_FIELDS = "id,number,status,currency,total,total_tax,shipping_total,discount_total,date_created,date_paid,date_completed,payment_method_title,customer_id,customer_note,billing,shipping,line_items,shipping_lines,refunds";

const Pagination = {
  page: z.number().int().min(1).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
};

export function createServer(deps: ServerDeps): McpServer {
  const { config } = deps;
  const client = deps.client ?? new WooClient(config);
  const proposals = deps.proposals ?? new ProposalStore(config.proposalsFile);
  const view = <T>(data: T): T => (config.redactPii ? redact(data) : data);

  const server = new McpServer({ name: "woocommerce-mcp-server", version: "0.1.0" }, {
    instructions: [
      "You are connected to a WooCommerce store through a read-mostly MCP server.",
      "Read tools return live data; customer PII is masked unless the operator disabled redaction.",
      "You cannot change the store directly. To change something, create a proposal with a clear reason;",
      "a human reviews it out of band and only an approved proposal can be applied with apply_proposal.",
      "Never ask the user for their store credentials; the operator configured them.",
    ].join(" "),
  });

  // ---------------------------------------------------------------- read tools
  server.registerTool(
    "store_info",
    {
      title: "Store info",
      description: "Store name, URL, currency, WooCommerce/WordPress versions and active payment gateways.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const [status, gateways] = await Promise.all([
          client.get<AnyJson>("system_status", { _fields: "environment,settings" }),
          client.get<{ id: string; title: string; enabled: boolean }[]>("payment_gateways"),
        ]);
        return ok({
          url: config.url,
          wc_version: status.environment?.version,
          wp_version: status.environment?.wp_version,
          currency: status.settings?.currency,
          currency_symbol: status.settings?.currency_symbol,
          payment_gateways: gateways.filter((g) => g.enabled).map((g) => g.title),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_products",
    {
      title: "List / search products",
      description: "Search the catalogue by text, SKU, status, category or stock status. Returns a page of products with price and stock.",
      inputSchema: {
        search: z.string().optional().describe("Free-text search on name/description"),
        sku: z.string().optional(),
        status: z.enum(["publish", "draft", "pending", "private", "any"]).default("publish"),
        stock_status: z.enum(["instock", "outofstock", "onbackorder"]).optional(),
        category: z.number().int().optional().describe("Category id"),
        orderby: z.enum(["date", "title", "price", "popularity", "rating", "modified"]).default("date"),
        order: z.enum(["asc", "desc"]).default("desc"),
        ...Pagination,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const page = await client.getPage("products", { ...args, _fields: PRODUCT_FIELDS });
        return ok({ ...page, items: view(page.items) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "Full product by id or SKU, including variations summary for variable products.",
      inputSchema: { id: z.number().int().optional(), sku: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id, sku }) => {
      try {
        let product: AnyJson | undefined;
        if (id !== undefined) product = await client.get("products/" + id);
        else if (sku) product = (await client.get<AnyJson[]>("products", { sku }))[0];
        else return fail(new Error("Provide id or sku"));
        if (!product) return fail(new Error(`No product with sku ${sku}`));
        const variations =
          product.type === "variable"
            ? await client.get<unknown[]>(`products/${product.id}/variations`, { per_page: 100, _fields: "id,sku,price,stock_status,stock_quantity,attributes" })
            : undefined;
        return ok(view({ ...product, variations }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "low_stock_products",
    {
      title: "Low stock",
      description: "Products with managed stock at or below a threshold (the product's own low-stock amount, or `threshold`).",
      inputSchema: { threshold: z.number().int().min(0).default(5), per_page: z.number().int().min(1).max(100).default(100) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ threshold, per_page }) => {
      try {
        const page = await client.getPage<AnyJson>("products", { per_page, status: "publish", _fields: PRODUCT_FIELDS, orderby: "title", order: "asc" });
        const low = page.items.filter((p) => p.manage_stock && typeof p.stock_quantity === "number" && p.stock_quantity <= (p.low_stock_amount ?? threshold));
        return ok({ threshold, scanned: page.items.length, total_products: page.total, items: view(low) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: "Orders filtered by status, date range, customer or search term (order number, name, email).",
      inputSchema: {
        status: z.enum(["any", "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "trash"]).default("any"),
        after: z.string().datetime().optional().describe("ISO 8601 lower bound on creation date"),
        before: z.string().datetime().optional(),
        customer: z.number().int().optional().describe("Customer id"),
        search: z.string().optional(),
        ...Pagination,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const page = await client.getPage("orders", { ...args, _fields: ORDER_FIELDS });
        return ok({ ...page, items: view(page.items) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "One order with line items, shipping, payment and notes.",
      inputSchema: { id: z.number().int() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const [order, notes] = await Promise.all([
          client.get<AnyJson>(`orders/${id}`),
          client.get<unknown[]>(`orders/${id}/notes`, { _fields: "id,date_created,note,customer_note" }),
        ]);
        return ok(view({ ...order, notes }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_customers",
    {
      title: "Search customers",
      description: "Registered customers by email or name. PII is masked by default.",
      inputSchema: { search: z.string().min(2), ...Pagination },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const page = await client.getPage("customers", { ...args, _fields: "id,email,first_name,last_name,date_created,orders_count,total_spent,billing" });
        return ok({ ...page, items: view(page.items) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sales_summary",
    {
      title: "Sales summary",
      description: "Totals (sales, orders, items, refunds, average) for a period: week, month, last_month, year, or a custom date range.",
      inputSchema: {
        period: z.enum(["week", "month", "last_month", "year"]).optional(),
        date_min: z.string().date().optional(),
        date_max: z.string().date().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const report = await client.get<AnyJson[]>("reports/sales", args);
        const r = report[0] ?? {};
        return ok({
          period: args.period ?? `${args.date_min ?? "?"}..${args.date_max ?? "?"}`,
          total_sales: r.total_sales,
          net_sales: r.net_sales,
          total_orders: r.total_orders,
          total_items: r.total_items,
          total_refunds: r.total_refunds,
          average_sales: r.average_sales,
          by_day: r.totals,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----------------------------------------------------------- proposals (write path)
  const propose = (kind: ProposalKind, summary: string, reason: string, payload: Record<string, unknown>): ToolResult => {
    const p = proposals.create({ kind, summary, reason, payload });
    return ok({
      proposal_id: p.id,
      status: p.status,
      summary: p.summary,
      next_step: config.allowWrites
        ? "A human must approve this proposal (CLI: woocommerce-mcp-server approve <id>) before you call apply_proposal."
        : "This server runs read-only (WOO_ALLOW_WRITES=false): the proposal is recorded for review but cannot be applied here.",
    });
  };

  server.registerTool(
    "propose_order_note",
    {
      title: "Propose: add order note",
      description: "Propose adding a note to an order (private by default, or visible to the customer). Requires human approval.",
      inputSchema: {
        order_id: z.number().int(),
        note: z.string().min(1).max(2000),
        customer_note: z.boolean().default(false).describe("true = the customer is notified"),
        reason: z.string().min(5).describe("Why this change is needed, for the human reviewer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ order_id, note, customer_note, reason }) =>
      propose("order_note", `Add ${customer_note ? "customer-visible" : "private"} note to order #${order_id}: "${note.slice(0, 80)}"`, reason, { order_id, note, customer_note }),
  );

  server.registerTool(
    "propose_order_status",
    {
      title: "Propose: change order status",
      description: "Propose a new status for an order (e.g. on-hold → processing). Requires human approval.",
      inputSchema: {
        order_id: z.number().int(),
        status: z.enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]),
        reason: z.string().min(5),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ order_id, status, reason }) => propose("order_status", `Set order #${order_id} to ${status}`, reason, { order_id, status }),
  );

  server.registerTool(
    "propose_stock_update",
    {
      title: "Propose: set stock quantity",
      description: "Propose a new stock quantity for a product or variation. Requires human approval.",
      inputSchema: {
        product_id: z.number().int(),
        variation_id: z.number().int().optional(),
        stock_quantity: z.number().int().min(0),
        reason: z.string().min(5),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ product_id, variation_id, stock_quantity, reason }) =>
      propose("stock_update", `Set stock of product ${product_id}${variation_id ? `/variation ${variation_id}` : ""} to ${stock_quantity}`, reason, { product_id, variation_id, stock_quantity }),
  );

  server.registerTool(
    "propose_price_update",
    {
      title: "Propose: change price",
      description: "Propose a new regular and/or sale price (as strings in store currency, e.g. \"19.90\"). Requires human approval.",
      inputSchema: {
        product_id: z.number().int(),
        variation_id: z.number().int().optional(),
        regular_price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        sale_price: z.string().regex(/^\d+(\.\d{1,2})?$|^$/).optional().describe("Empty string removes the sale"),
        reason: z.string().min(5),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ product_id, variation_id, regular_price, sale_price, reason }) => {
      if (regular_price === undefined && sale_price === undefined) return fail(new Error("Provide regular_price and/or sale_price"));
      const parts = [regular_price !== undefined && `regular=${regular_price}`, sale_price !== undefined && `sale=${sale_price || "none"}`].filter(Boolean).join(", ");
      return propose("price_update", `Price of product ${product_id}${variation_id ? `/variation ${variation_id}` : ""}: ${parts}`, reason, { product_id, variation_id, regular_price, sale_price });
    },
  );

  server.registerTool(
    "propose_refund",
    {
      title: "Propose: refund",
      description: "Propose a (partial) refund on an order. Money moves only after a human approves and apply_proposal runs.",
      inputSchema: {
        order_id: z.number().int(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/).describe("Amount in store currency"),
        refund_reason: z.string().min(3).max(500),
        api_refund: z.boolean().default(false).describe("true = also refund through the payment gateway"),
        reason: z.string().min(5),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ order_id, amount, refund_reason, api_refund, reason }) =>
      propose("refund", `Refund ${amount} on order #${order_id}${api_refund ? " via gateway" : " (manual)"}: ${refund_reason}`, reason, { order_id, amount, refund_reason, api_refund }),
  );

  server.registerTool(
    "list_proposals",
    {
      title: "List proposals",
      description: "Proposals and their status (pending, approved, rejected, applied, failed).",
      inputSchema: { status: z.enum(["pending", "approved", "rejected", "applied", "failed"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => ok({ items: proposals.list(status) }),
  );

  server.registerTool(
    "apply_proposal",
    {
      title: "Apply an approved proposal",
      description: "Executes a proposal that a human has approved. Fails for pending or rejected proposals and on read-only servers.",
      inputSchema: { proposal_id: z.string().min(4) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ proposal_id }) => {
      if (!config.allowWrites) return fail(new Error("This server is read-only (WOO_ALLOW_WRITES=false)"));
      const p = proposals.get(proposal_id);
      if (!p) return fail(new Error(`Unknown proposal ${proposal_id}`));
      if (p.status !== "approved") return fail(new Error(`Proposal ${p.id} is ${p.status}; only approved proposals can be applied`));
      try {
        const result = await execute(client, p);
        return ok({ proposal: proposals.markApplied(p.id, view(result)) });
      } catch (e) {
        proposals.markFailed(p.id, (e as Error).message);
        return fail(e);
      }
    },
  );

  return server;
}

export async function execute(client: WooClient, p: Proposal): Promise<unknown> {
  const x = p.payload as AnyJson;
  switch (p.kind) {
    case "order_note":
      return client.post(`orders/${x.order_id}/notes`, { note: x.note, customer_note: x.customer_note });
    case "order_status":
      return client.put(`orders/${x.order_id}`, { status: x.status });
    case "stock_update": {
      const path = x.variation_id ? `products/${x.product_id}/variations/${x.variation_id}` : `products/${x.product_id}`;
      return client.put(path, { manage_stock: true, stock_quantity: x.stock_quantity });
    }
    case "price_update": {
      const path = x.variation_id ? `products/${x.product_id}/variations/${x.variation_id}` : `products/${x.product_id}`;
      const body: Record<string, string> = {};
      if (x.regular_price !== undefined) body.regular_price = x.regular_price;
      if (x.sale_price !== undefined) body.sale_price = x.sale_price;
      return client.put(path, body);
    }
    case "refund":
      return client.post(`orders/${x.order_id}/refunds`, { amount: x.amount, reason: x.refund_reason, api_refund: x.api_refund });
  }
}
