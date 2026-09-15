// The only piece of the wallpaper rotation that talks to the internet. One interface, a real
// implementation on Node's fetch with a descriptive User-Agent, size and time limits, and a fake for tests.
export interface FetchResult {
  status: number;
  contentType: string | null;
  body: Buffer;
}
export interface Fetcher {
  fetch(url: string, opts?: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string; maxBytes?: number; timeoutMs?: number }): Promise<FetchResult>;
}

export const USER_AGENT = 'harbor-wallpapers/0.5 (self-hosted app manager; +https://github.com/carlosalaniz/harbor)';

export class RealFetcher implements Fetcher {
  async fetch(url: string, opts: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string; maxBytes?: number; timeoutMs?: number } = {}): Promise<FetchResult> {
    const max = opts.maxBytes ?? 16 * 1024 * 1024;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await fetch(url, { method: opts.method ?? 'GET', headers: { 'user-agent': USER_AGENT, accept: '*/*', ...(opts.headers ?? {}) }, ...(opts.body !== undefined ? { body: opts.body } : {}), redirect: 'follow', signal: ctl.signal });
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > max) throw new Error(`response too large (${len} bytes)`);
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > max) {
            await reader.cancel();
            throw new Error(`response too large (> ${max} bytes)`);
          }
          chunks.push(Buffer.from(value));
        }
      }
      return { status: res.status, contentType: res.headers.get('content-type'), body: Buffer.concat(chunks) };
    } finally {
      clearTimeout(t);
    }
  }
}

// Tests and `pnpm dev`: answers from a table keyed by URL prefix; records every request.
export class FakeFetcher implements Fetcher {
  routes: { match: (url: string) => boolean; reply: (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }) => FetchResult }[] = [];
  requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  on(prefix: string | RegExp, reply: FetchResult | ((url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }) => FetchResult)): this {
    this.routes.push({ match: (u) => (typeof prefix === 'string' ? u.startsWith(prefix) : prefix.test(u)), reply: typeof reply === 'function' ? reply : () => reply });
    return this;
  }
  async fetch(url: string, opts: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string } = {}): Promise<FetchResult> {
    this.requests.push({ url, method: opts.method ?? 'GET', headers: opts.headers ?? {} });
    const r = this.routes.find((x) => x.match(url));
    if (!r) return { status: 404, contentType: 'text/plain', body: Buffer.from(`fake fetcher: no route for ${url}`) };
    return r.reply(url, opts);
  }
}

export const json = (value: unknown, status = 200): FetchResult => ({ status, contentType: 'application/json', body: Buffer.from(JSON.stringify(value)) });
