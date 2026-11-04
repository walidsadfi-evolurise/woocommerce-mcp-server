# Security

Report vulnerabilities privately to walid.sadfi@evolurise.com. Acknowledgement within 72 hours.

Operating notes:

- Create a **Read** WooCommerce API key unless you enable writes; the server cannot do more than the key allows.
- `WOO_ALLOW_WRITES=true` only makes *approved* proposals executable. Keep `MCP_ADMIN_TOKEN` away from the agent.
- Over plain HTTP, WooCommerce requires the key/secret in the query string; use that only against localhost.
- The proposals file contains order ids, amounts and your reasons — treat it like a log.
