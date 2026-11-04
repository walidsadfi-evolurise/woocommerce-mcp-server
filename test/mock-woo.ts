/** A small fake of the WooCommerce REST API v3, enough to exercise every tool. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

export interface MockWoo {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
  authSeen: { basic: boolean; query: boolean };
}

const products = [
  { id: 10, name: "Blue Hoodie", slug: "blue-hoodie", sku: "HOOD-BLU", type: "simple", status: "publish", price: "49.90", regular_price: "49.90", sale_price: "", on_sale: false, stock_status: "instock", stock_quantity: 3, manage_stock: true, low_stock_amount: 5, categories: [{ id: 1, name: "Apparel" }] },
  { id: 11, name: "Red Cap", slug: "red-cap", sku: "CAP-RED", type: "simple", status: "publish", price: "19.00", regular_price: "19.00", sale_price: "", on_sale: false, stock_status: "instock", stock_quantity: 40, manage_stock: true, low_stock_amount: null, categories: [] },
  { id: 12, name: "Variable Tee", slug: "variable-tee", sku: "TEE", type: "variable", status: "publish", price: "25.00", regular_price: "", sale_price: "", on_sale: false, stock_status: "instock", stock_quantity: null, manage_stock: false, low_stock_amount: null, categories: [] },
];
const variations = [{ id: 120, sku: "TEE-S", price: "25.00", stock_status: "instock", stock_quantity: 7, attributes: [{ name: "Size", option: "S" }] }];
const orders = [
  {
    id: 500, number: "500", status: "processing", currency: "EUR", total: "68.90", total_tax: "11.48", shipping_total: "0.00", discount_total: "0.00",
    date_created: "2026-11-01T10:00:00", date_paid: "2026-11-01T10:01:00", payment_method_title: "Card", customer_id: 7, customer_note: "",
    billing: { first_name: "Marie", last_name: "Dupont", company: "", address_1: "12 rue des Lilas", address_2: "", city: "Lyon", postcode: "69003", country: "FR", email: "marie.dupont@example.com", phone: "+33612345678" },
    shipping: { first_name: "Marie", last_name: "Dupont", address_1: "12 rue des Lilas", city: "Lyon", postcode: "69003", country: "FR" },
    line_items: [{ id: 1, name: "Blue Hoodie", product_id: 10, quantity: 1, total: "49.90" }, { id: 2, name: "Red Cap", product_id: 11, quantity: 1, total: "19.00" }],
    customer_ip_address: "203.0.113.9", transaction_id: "ch_123",
  },
];
const customers = [{ id: 7, email: "marie.dupont@example.com", first_name: "Marie", last_name: "Dupont", date_created: "2025-01-01T00:00:00", orders_count: 3, total_spent: "210.00", billing: { city: "Lyon", country: "FR", phone: "+33612345678" } }];

export async function startMockWoo(opts: { requireAuth?: boolean } = {}): Promise<MockWoo> {
  const requests: Recorded[] = [];
  const authSeen = { basic: false, query: false };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    const query = Object.fromEntries(url.searchParams);
    const path = url.pathname.replace(/^\/wp-json\/wc\/v3\//, "");
    requests.push({ method: req.method ?? "GET", path, query, body });

    if (req.headers.authorization?.startsWith("Basic ")) authSeen.basic = true;
    if (query.consumer_key) authSeen.query = true;
    if (opts.requireAuth && !authSeen.basic && !query.consumer_key) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot list resources.", data: { status: 401 } }));
    }

    const send = (status: number, data: unknown, total?: number) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (total !== undefined) {
        headers["x-wp-total"] = String(total);
        headers["x-wp-totalpages"] = String(Math.max(1, Math.ceil(total / Number(query.per_page ?? 10))));
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(data));
    };
    const notFound = (code: string) => send(404, { code, message: "Invalid ID.", data: { status: 404 } });

    let m: RegExpMatchArray | null;
    if (path === "system_status") return send(200, { environment: { version: "9.9.0", wp_version: "6.8" }, settings: { currency: "EUR", currency_symbol: "€" } });
    if (path === "payment_gateways") return send(200, [{ id: "stripe", title: "Card (Stripe)", enabled: true }, { id: "cod", title: "Cash on delivery", enabled: false }]);
    if (path === "products") {
      let items = products.filter((p) => !query.sku || p.sku === query.sku).filter((p) => !query.search || p.name.toLowerCase().includes(query.search.toLowerCase()));
      if (query.stock_status) items = items.filter((p) => p.stock_status === query.stock_status);
      return send(200, items, items.length);
    }
    if ((m = path.match(/^products\/(\d+)\/variations\/(\d+)$/))) {
      if (req.method === "PUT") return send(200, { id: Number(m[2]), ...body });
      return send(200, variations.find((v) => v.id === Number(m![2])) ?? {});
    }
    if ((m = path.match(/^products\/(\d+)\/variations$/))) return send(200, Number(m[1]) === 12 ? variations : [], 1);
    if ((m = path.match(/^products\/(\d+)$/))) {
      const p = products.find((x) => x.id === Number(m![1]));
      if (!p) return notFound("woocommerce_rest_product_invalid_id");
      if (req.method === "PUT") return send(200, { ...p, ...body });
      return send(200, p);
    }
    if (path === "orders") {
      const items = orders.filter((o) => !query.status || query.status === "any" || o.status === query.status).filter((o) => !query.customer || o.customer_id === Number(query.customer));
      return send(200, items, items.length);
    }
    if ((m = path.match(/^orders\/(\d+)\/notes$/))) {
      if (req.method === "POST") return send(201, { id: 99, note: body.note, customer_note: body.customer_note, date_created: "2026-11-04T09:00:00" });
      return send(200, [{ id: 1, date_created: "2026-11-01T10:02:00", note: "Payment received", customer_note: false }]);
    }
    if ((m = path.match(/^orders\/(\d+)\/refunds$/))) return send(201, { id: 77, amount: body.amount, reason: body.reason });
    if ((m = path.match(/^orders\/(\d+)$/))) {
      const o = orders.find((x) => x.id === Number(m![1]));
      if (!o) return notFound("woocommerce_rest_shop_order_invalid_id");
      if (req.method === "PUT") return send(200, { ...o, ...body });
      return send(200, o);
    }
    if (path === "customers") return send(200, customers.filter((c) => !query.search || c.email.includes(query.search) || c.last_name.toLowerCase().includes(query.search.toLowerCase())), 1);
    if (path === "reports/sales") return send(200, [{ total_sales: "1234.50", net_sales: "1028.75", total_orders: 18, total_items: 31, total_refunds: "20.00", average_sales: "176.36", totals: { "2026-11-01": { sales: "68.90", orders: 1 } } }]);
    if (path === "broken") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html>not json</html>");
    }
    return notFound("rest_no_route");
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    authSeen,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
