# woocommerce-mcp-server

**An MCP server that lets an AI agent work with a WooCommerce store — read everything it needs, and change nothing without a human saying yes.**

[![CI](https://github.com/walidsadfi-evolurise/woocommerce-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/walidsadfi-evolurise/woocommerce-mcp-server/actions/workflows/ci.yml)
![Node 20+](https://img.shields.io/badge/node-20%2B-brightgreen)
![License MIT](https://img.shields.io/badge/license-MIT-green)

*[Version française plus bas](#version-française)*

Connect Claude Desktop, Cursor, or your own agent to a store and ask: *"Which products are about to run out?"*, *"Where is order 500?"*, *"How did we do this month vs last month?"*. When the agent wants to **change** something — set an order to completed, refund 19 €, drop a price — it files a **proposal** with a reason. You approve it from the CLI or an admin endpoint the agent has no token for. Only then can it be applied.

```text
agent  → propose_refund(order 500, 19.00, "Cap arrived damaged")       status: pending
human  → woocommerce-mcp-server approve 3f9c                         status: approved
agent  → apply_proposal(3f9c)                                         POST /orders/500/refunds  ✓
```

Built after wiring agents into client stores: the useful part was never "can the model call the API", it was **what the model is allowed to see and do**, and who signs off.

## Tools

| Read (always on) | Write (proposal → human approval → apply) |
|---|---|
| `store_info` versions, currency, enabled gateways | `propose_order_note` private or customer-visible |
| `list_products` search / sku / status / stock / category | `propose_order_status` |
| `get_product` by id or SKU, with variations | `propose_stock_update` product or variation |
| `low_stock_products` honours each product's own threshold | `propose_price_update` regular / sale |
| `list_orders` status, dates, customer, search | `propose_refund` manual or via gateway |
| `get_order` with notes | `list_proposals` |
| `search_customers` | `apply_proposal` — refused unless approved and `WOO_ALLOW_WRITES=true` |
| `sales_summary` week / month / last_month / year / range | |
| `list_coupons` validity, usage, expiry flags | |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`) so clients can show the right confirmation UI.

### Safety defaults

- **Read-only** unless `WOO_ALLOW_WRITES=true`. Proposals are still recorded, so you can run it read-only and review what the agent *would* have done.
- **PII masked**: emails → `m***@example.com`, phones → `***78`, names → initials, street lines and IPs dropped. City, postcode and country stay for shipping questions. `WOO_REDACT_PII=false` to disable.
- **Separate approver identity**: in HTTP mode the agent uses `MCP_HTTP_TOKEN`, approvals need `MCP_ADMIN_TOKEN`, and the server refuses to start if they're equal.
- **Idempotent gate**: a proposal is applied at most once; its result or error is stored with it.
- Input is validated with zod before any request reaches the store.

## Install

```bash
npm i -g woocommerce-mcp-server          # or: npx woocommerce-mcp-server
```

Create a REST API key in WooCommerce → Settings → Advanced → REST API (**Read** permission is enough for read-only use).

### Claude Desktop / Cursor (stdio)

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "npx",
      "args": ["-y", "woocommerce-mcp-server"],
      "env": {
        "WOO_URL": "https://shop.example.com",
        "WOO_CONSUMER_KEY": "ck_…",
        "WOO_CONSUMER_SECRET": "cs_…"
      }
    }
  }
}
```

### Server mode (Streamable HTTP)

```bash
cp .env.example .env   # fill it in, with two different tokens
woocommerce-mcp-server http --port 3333
# agent:  POST http://host:3333/mcp          Authorization: Bearer $MCP_HTTP_TOKEN
# human:  GET  http://host:3333/proposals    Authorization: Bearer $MCP_ADMIN_TOKEN
#         POST http://host:3333/proposals/<id>/approve   (or /reject)
```

Docker:

```bash
docker run -d --env-file .env -v woo-proposals:/data -p 3333:3333 ghcr.io/walidsadfi-evolurise/woocommerce-mcp-server
```

### Reviewing proposals from the terminal

```text
$ woocommerce-mcp-server proposals
3f9c1a2e  pending   refund         Refund 19.00 on order #500 (manual): Cap arrived damaged
          reason: Photo received from customer, cap crushed in transit
$ woocommerce-mcp-server approve 3f9c
approved: Refund 19.00 on order #500 (manual): Cap arrived damaged
```

The proposals file (`WOO_PROPOSALS_FILE`) is plain JSON, so the approver can be a different process, a cron that posts to Slack, or a tiny back-office page.

## Development

```bash
npm ci
npm test            # vitest against an in-process fake WooCommerce API
npm run lint && npm run typecheck && npm run build
```

Tests spin up a fake WooCommerce REST API (`test/mock-woo.ts`) and talk to the server through the real MCP client over in-memory and HTTP transports, so the suite covers transport, validation, redaction and the whole proposal lifecycle without touching a store.

## Roadmap

- [ ] Resources: `woo://orders/{id}` for clients that prefer resources over tools
- [ ] Prompts: daily store briefing, "handle this support ticket"
- [ ] Shipping zones (read)
- [ ] Webhook listener → MCP notifications on new orders

## License

MIT — see [LICENSE](LICENSE). Built by [Walid Sadfi](https://www.malt.fr/profile/walidsadfi), Forward Deployed Engineer · agents IA & WooCommerce. See also [woocommerce-agent-ready](https://github.com/walidsadfi-evolurise/woocommerce-agent-ready), which audits a store for the agentic-commerce protocols (Store API, MCP, structured data).

---

## Version française

**Un serveur MCP qui permet à un agent IA de travailler avec une boutique WooCommerce : lire tout ce dont il a besoin, et ne rien modifier sans qu'un humain dise oui.**

Branchez Claude Desktop, Cursor ou votre propre agent sur une boutique et demandez : *« Quels produits vont être en rupture ? »*, *« Où en est la commande 500 ? »*, *« Comment s'est passé le mois par rapport au précédent ? »*. Quand l'agent veut **modifier** quelque chose (passer une commande en terminée, rembourser 19 €, baisser un prix), il dépose une **proposition** motivée. Vous l'approuvez depuis le terminal ou un endpoint admin dont l'agent n'a pas le token. Seulement ensuite, elle peut être appliquée.

- **Lecture seule par défaut** (`WOO_ALLOW_WRITES=false`) : les propositions sont tout de même enregistrées, idéal pour observer ce que l'agent *aurait* fait.
- **Données personnelles masquées par défaut** : emails, téléphones, noms et adresses postales ; la ville et le pays restent pour les questions de livraison.
- **Deux identités** en mode HTTP : token agent et token approbateur, obligatoirement différents.
- **Une proposition s'applique au plus une fois**, avec son résultat ou son erreur archivé.
- Transports stdio et HTTP, image Docker, 27 tests contre une fausse API WooCommerce.

```bash
npx woocommerce-mcp-server            # stdio, pour Claude Desktop / Cursor
woocommerce-mcp-server http           # mode serveur
woocommerce-mcp-server proposals      # relire ce que l'agent propose
woocommerce-mcp-server approve <id>
```

Vous voulez ça branché sur votre boutique, avec un process de validation qui colle à votre équipe et un point de mesure ? [Parlons-en sur Malt](https://www.malt.fr/profile/walidsadfi).
