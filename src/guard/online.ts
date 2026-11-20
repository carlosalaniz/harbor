// Asking an app about an address (decision 209): an installed, running app whose package declares
// `provides.ipLookup` answers GET http://127.0.0.1:<its endpoint's host port><path>?ip=<address>. Harbor trusts the
// answer as data only: every field is checked, cut to size and dropped when unknown. PURE apart from the fetch.
export const LOOKUP_FLAGS = ['hosting', 'vpn', 'proxy', 'tor', 'relay', 'bogon'] as const;
export type LookupFlag = (typeof LOOKUP_FLAGS)[number];

export interface OnlineResult {
  source: string;
  ok: boolean;
  error?: string;
  country?: string;
  region?: string;
  city?: string;
  asn?: string;
  org?: string;
  hostname?: string;
  abuseScore?: number;
  reports?: number;
  lastReportedAt?: string;
  usage?: string;
  flags?: LookupFlag[];
}

export interface OnlineAnswer {
  results: OnlineResult[];
  note: string | null;
}

const MAX_BYTES = 64 * 1024;
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

export function sanitizeOnlineAnswer(doc: unknown): OnlineAnswer {
  const d = doc as { format?: unknown; results?: unknown; note?: unknown } | null;
  if (!d || typeof d !== 'object' || d.format !== 1 || !Array.isArray(d.results)) throw new Error('the app answered in a format Harbor does not know');
  const results: OnlineResult[] = [];
  for (const r of d.results.slice(0, 8) as Record<string, unknown>[]) {
    const source = str(r?.['source'], 40);
    if (!source || !/^[a-z0-9][a-z0-9_.-]*$/i.test(source)) continue;
    const ok = r['ok'] === true;
    const out: OnlineResult = { source, ok };
    if (!ok) {
      out.error = str(r['error'], 120) ?? 'failed';
      results.push(out);
      continue;
    }
    const set = <K extends keyof OnlineResult>(k: K, v: OnlineResult[K] | undefined) => {
      if (v !== undefined) out[k] = v;
    };
    set('country', str(r['country'], 8));
    set('region', str(r['region'], 120));
    set('city', str(r['city'], 120));
    set('asn', str(r['asn'], 16));
    set('org', str(r['org']));
    set('hostname', str(r['hostname'], 253));
    set('abuseScore', num(r['abuseScore'], 0, 100));
    set('reports', num(r['reports'], 0, 1e9));
    const at = str(r['lastReportedAt'], 40);
    set('lastReportedAt', at && !Number.isNaN(Date.parse(at)) ? at : undefined);
    set('usage', str(r['usage'], 120));
    if (Array.isArray(r['flags'])) {
      const flags = [...new Set((r['flags'] as unknown[]).filter((f): f is LookupFlag => (LOOKUP_FLAGS as readonly unknown[]).includes(f)))];
      if (flags.length) out.flags = flags;
    }
    results.push(out);
  }
  return { results, note: str(d.note, 300) ?? null };
}

type Fetch = (url: string, init?: { signal?: AbortSignal; redirect?: 'error' }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function askLookupApp(hostPort: number, pathPart: string, address: string, fetchImpl: Fetch = (u, i) => fetch(u, i)): Promise<OnlineAnswer> {
  const url = `http://127.0.0.1:${hostPort}${pathPart}?ip=${encodeURIComponent(address)}`;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  } catch (e) {
    throw new Error((e as Error).name === 'TimeoutError' ? 'the app did not answer within 20 seconds' : `the app could not be reached (${(e as Error).message})`, { cause: e });
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('the app answered with more than Harbor reads');
  if (!res.ok) throw new Error(`the app answered HTTP ${res.status}`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error('the app did not answer with JSON', { cause: e });
  }
  return sanitizeOnlineAnswer(doc);
}
