# Changelog

## 0.2.0 — 2026-11-13

- `list_coupons` read tool with `expired` / `exhausted` flags.
- `npm run check` script (typecheck + lint + tests), which the release workflow already called.
- Explicit `stdio` command (same as no command), so container runners can pick the transport.
- Published to the official MCP Registry as `io.github.walidsadfi-evolurise/woocommerce-mcp-server` (OCI image on ghcr.io, `server.json`, OIDC publish step in the release workflow).

## 0.1.0 — 2026-11-04

- 8 read tools: store_info, list_products, get_product, low_stock_products, list_orders, get_order, search_customers, sales_summary.
- Proposal gate for writes: propose_order_note / order_status / stock_update / price_update / refund, list_proposals, apply_proposal.
- Approvals from the CLI (`approve`, `reject`, `proposals`) or the admin HTTP endpoints with a separate token.
- PII redaction on by default; read-only by default.
- stdio and Streamable HTTP transports; Docker image.
