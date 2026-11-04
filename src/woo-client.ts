/**
 * Thin client for the WooCommerce REST API v3.
 *
 * Authentication: HTTP Basic over HTTPS (the WooCommerce recommendation); over
 * plain HTTP (local dev only) the key/secret go in the query string, which is
 * what WooCommerce requires in that case.
 */

export class WooError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "WooError";
  }
}

export interface Page<T> {
  items: T[];
  total: number;
  totalPages: number;
  page: number;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface WooClientOptions {
  url: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class WooClient {
  private readonly base: URL;
  private readonly auth: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly useQueryAuth: boolean;

  constructor(private readonly opts: WooClientOptions) {
    this.base = new URL(opts.url.replace(/\/+$/, "") + "/wp-json/wc/v3/");
    this.auth = "Basic " + Buffer.from(`${opts.consumerKey}:${opts.consumerSecret}`).toString("base64");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.useQueryAuth = this.base.protocol === "http:";
  }

  private url(path: string, query: Query = {}): URL {
    const u = new URL(path.replace(/^\/+/, ""), this.base);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    }
    if (this.useQueryAuth) {
      u.searchParams.set("consumer_key", this.opts.consumerKey);
      u.searchParams.set("consumer_secret", this.opts.consumerSecret);
    }
    return u;
  }

  private async request<T>(method: string, path: string, query: Query = {}, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url(path, query), {
        method,
        headers: {
          accept: "application/json",
          "user-agent": "woocommerce-mcp-server/0.1",
          ...(this.useQueryAuth ? {} : { authorization: this.auth }),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        throw new WooError(`Non-JSON response from ${path} (HTTP ${res.status}). Is this a WooCommerce site?`, res.status);
      }
      if (!res.ok) {
        const err = (data ?? {}) as { code?: string; message?: string };
        throw new WooError(err.message ?? `HTTP ${res.status}`, res.status, err.code);
      }
      return { data: data as T, headers: res.headers };
    } catch (err) {
      if (err instanceof WooError) throw err;
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      if ((err as Error).name === "AbortError") throw new WooError(`Timeout after ${this.timeoutMs} ms on ${path}`, 0);
      throw new WooError(`Network error on ${path}: ${cause ?? (err as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  async get<T>(path: string, query: Query = {}): Promise<T> {
    return (await this.request<T>("GET", path, query)).data;
  }

  async getPage<T>(path: string, query: Query = {}): Promise<Page<T>> {
    const page = Number(query.page ?? 1);
    const { data, headers } = await this.request<T[]>("GET", path, { per_page: 20, ...query, page });
    return {
      items: data,
      total: Number(headers.get("x-wp-total") ?? data.length),
      totalPages: Number(headers.get("x-wp-totalpages") ?? 1),
      page,
    };
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>("POST", path, {}, body)).data;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>("PUT", path, {}, body)).data;
  }
}
