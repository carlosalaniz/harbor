import { promises as dns } from 'node:dns';
import { request as httpsRequest } from 'node:https';

// Network facts for the public-publishing wizard: this machine's public address and what a hostname
// resolves to. Real implementation asks two public "what is my IP" services over HTTPS (nothing
// else leaves the machine); the fake in tests answers from a table.
export interface NetProvider {
  publicIp(): Promise<{ v4: string | null; v6: string | null; error: string | null }>;
  resolve(hostname: string): Promise<{ a: string[]; aaaa: string[]; error: string | null }>;
}

function getText(url: string, family: 4 | 6, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', family, timeout: timeoutMs, headers: { 'user-agent': 'harbor-public-ip/1', accept: 'text/plain' } }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => (res.statusCode === 200 ? resolve(body.trim()) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const V4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const V6 = /^[0-9a-f:]+$/i;

export class RealNet implements NetProvider {
  async publicIp(): Promise<{ v4: string | null; v6: string | null; error: string | null }> {
    const errors: string[] = [];
    const v4 = await getText('https://api4.ipify.org', 4).catch((e: Error) => (errors.push(`v4: ${e.message}`), null));
    const v6 = await getText('https://api6.ipify.org', 6).catch(() => null);
    return { v4: v4 && V4.test(v4) ? v4 : null, v6: v6 && V6.test(v6) && v6.includes(':') ? v6 : null, error: v4 ? null : errors.join('; ') || 'no public IPv4 detected' };
  }
  async resolve(hostname: string): Promise<{ a: string[]; aaaa: string[]; error: string | null }> {
    const a = await dns.resolve4(hostname).catch((e: NodeJS.ErrnoException) => (e.code === 'ENODATA' || e.code === 'ENOTFOUND' ? [] : Promise.reject(e))).catch((e: Error) => ({ error: e.message }));
    const aaaa = await dns.resolve6(hostname).catch(() => [] as string[]);
    if (!Array.isArray(a)) return { a: [], aaaa: [], error: a.error };
    return { a, aaaa: Array.isArray(aaaa) ? aaaa : [], error: null };
  }
}

export class FakeNet implements NetProvider {
  ip: { v4: string | null; v6: string | null; error: string | null } = { v4: '203.0.113.10', v6: null, error: null };
  records = new Map<string, { a: string[]; aaaa: string[] }>();
  async publicIp() {
    return { ...this.ip };
  }
  async resolve(hostname: string) {
    const r = this.records.get(hostname);
    return r ? { ...r, error: null } : { a: [], aaaa: [], error: null };
  }
}

// One judgement for the wizard: does this hostname point at us?
export function dnsState(addresses: { a: string[]; aaaa: string[] }, publicIp: { v4: string | null; v6: string | null }): { state: 'points_here' | 'points_elsewhere' | 'no_record' | 'unknown'; note: string | null } {
  const all = [...addresses.a, ...addresses.aaaa];
  if (all.length === 0) return { state: 'no_record', note: 'No A or AAAA record found yet. DNS changes can take a few minutes to spread.' };
  if (!publicIp.v4 && !publicIp.v6) return { state: 'unknown', note: `Resolves to ${all.join(', ')}; this machine's public address could not be detected, so Harbor cannot compare.` };
  const here = (publicIp.v4 && addresses.a.includes(publicIp.v4)) || (publicIp.v6 && addresses.aaaa.includes(publicIp.v6));
  if (here) return { state: 'points_here', note: null };
  return { state: 'points_elsewhere', note: `Resolves to ${all.join(', ')}, but this machine's public address is ${[publicIp.v4, publicIp.v6].filter(Boolean).join(' / ')}.` };
}
