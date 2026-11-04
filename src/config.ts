import { z } from "zod";

const Bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

export const ConfigSchema = z.object({
  /** Store root, e.g. https://shop.example.com */
  url: z.string().url(),
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
  /** When false (default) the server exposes read tools only; proposals can still be created but never applied. */
  allowWrites: Bool.default(false),
  /** Mask customer emails, phones and street addresses in every response (default true). */
  redactPii: Bool.default(true),
  /** Where proposals are persisted so a human can approve them from another process. */
  proposalsFile: z.string().default(".woo-proposals.json"),
  /** Request timeout in ms. */
  timeoutMs: z.coerce.number().int().positive().default(15_000),
  /** Bearer token required by the HTTP transport. */
  httpToken: z.string().optional(),
  /** Token for the approval endpoints of the HTTP transport (never the same as httpToken). */
  adminToken: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    url: env.WOO_URL,
    consumerKey: env.WOO_CONSUMER_KEY,
    consumerSecret: env.WOO_CONSUMER_SECRET,
    allowWrites: env.WOO_ALLOW_WRITES ?? false,
    redactPii: env.WOO_REDACT_PII ?? true,
    proposalsFile: env.WOO_PROPOSALS_FILE ?? ".woo-proposals.json",
    timeoutMs: env.WOO_TIMEOUT_MS ?? 15_000,
    httpToken: env.MCP_HTTP_TOKEN || undefined,
    adminToken: env.MCP_ADMIN_TOKEN || undefined,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration — ${issues}. Required: WOO_URL, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET.`);
  }
  if (parsed.data.adminToken && parsed.data.adminToken === parsed.data.httpToken) {
    throw new Error("MCP_ADMIN_TOKEN must differ from MCP_HTTP_TOKEN: the agent must not be able to approve its own proposals.");
  }
  return parsed.data;
}
