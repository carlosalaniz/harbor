import { request as httpsRequest } from 'node:https';
import type { UrlVerifier } from '../lifecycle/context.js';

// GET a published HTTPS address with full certificate verification (system CAs; Let's Encrypt and
// tailnet certificates chain to public roots). A 401 from basic-auth protection still proves the
// route is served, so it counts as reachable by default.
export const httpsVerifier: UrlVerifier = (url, opts = {}) =>
  new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, status: null, error: 'invalid url' });
      return;
    }
    const expected = opts.expectStatus ?? [200, 301, 302, 303, 307, 308, 401];
    const req = httpsRequest({ host: u.hostname, port: Number(u.port || 443), path: u.pathname || '/', method: 'GET', servername: u.hostname, timeout: opts.timeoutMs ?? 8000, headers: { host: u.host, 'user-agent': 'harbor-exposure-check/1' } }, (res) => {
      res.resume();
      resolve({ ok: expected.includes(res.statusCode ?? 0), status: res.statusCode ?? null, error: null });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, status: null, error: e.message }));
    req.end();
  });

export class FakeVerifier {
  // url -> result; unknown urls are reachable (200) unless `defaultOk` is false
  results = new Map<string, { ok: boolean; status: number | null; error: string | null }>();
  defaultOk = true;
  calls: string[] = [];
  readonly fn: UrlVerifier = async (url) => {
    this.calls.push(url);
    return this.results.get(url) ?? (this.defaultOk ? { ok: true, status: 200, error: null } : { ok: false, status: null, error: 'ECONNREFUSED (fake)' });
  };
}
