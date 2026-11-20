// Where an address is, from a local database only (decision 207, D3): DB-IP's free Lite files (country + network
// operator, CC BY 4.0, no account or key), downloaded the first time the operator asks and refreshed monthly after
// that. The looked-up address never leaves this machine; the only request out is the monthly download itself.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { HarborError } from '../errors.js';
import { MmdbReader } from './mmdb.js';
import { contains, parseCidr } from './rules.js';

export const GEO_ATTRIBUTION = { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' } as const;
const FILES = { country: 'dbip-country-lite', asn: 'dbip-asn-lite' } as const;
const MAX_GZ = 64 * 1024 * 1024;
const MAX_DB = 256 * 1024 * 1024;
// refreshed when the copy is older than this (DB-IP publishes once a month)
export const GEO_REFRESH_MS = 35 * 24 * 3600_000;

export interface GeoAnswer {
  country: string | null;
  countryName: string | null;
  asn: string | null;
  org: string | null;
}

export interface GeoStatus {
  ready: boolean;
  // the DB-IP edition (YYYY-MM) and when Harbor downloaded it
  edition: string | null;
  downloadedAt: string | null;
}

export interface GeoSource {
  status(): GeoStatus;
  // downloads the database on first use; null = the database knows nothing about it (private, reserved)
  lookup(address: string): Promise<GeoAnswer | null>;
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

function month(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function answerFrom(country: unknown, asn: unknown): GeoAnswer | null {
  const c = (country as { country?: { iso_code?: unknown; names?: { en?: unknown } } } | null)?.country;
  const a = asn as { autonomous_system_number?: unknown; autonomous_system_organization?: unknown } | null;
  const out: GeoAnswer = {
    country: typeof c?.iso_code === 'string' ? c.iso_code.slice(0, 8) : null,
    countryName: typeof c?.names?.en === 'string' ? c.names.en.slice(0, 120) : null,
    asn: typeof a?.autonomous_system_number === 'number' ? `AS${a.autonomous_system_number}` : null,
    org: typeof a?.autonomous_system_organization === 'string' ? a.autonomous_system_organization.slice(0, 200) : null,
  };
  return out.country || out.asn ? out : null;
}

export class DbIpGeo implements GeoSource {
  private readers: { country: MmdbReader; asn: MmdbReader } | null = null;
  private loading: Promise<void> | null = null;
  constructor(
    private readonly dir: string,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private metaFile() {
    return path.join(this.dir, 'meta.json');
  }

  status(): GeoStatus {
    try {
      const m = JSON.parse(readFileSync(this.metaFile(), 'utf8')) as { edition?: string; downloadedAt?: string };
      const ready = existsSync(path.join(this.dir, 'country.mmdb')) && existsSync(path.join(this.dir, 'asn.mmdb'));
      return { ready, edition: ready ? (m.edition ?? null) : null, downloadedAt: ready ? (m.downloadedAt ?? null) : null };
    } catch {
      return { ready: false, edition: null, downloadedAt: null };
    }
  }

  private async download(name: string): Promise<{ data: Buffer; edition: string }> {
    const now = this.now();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    let last = '';
    // a new month's file appears a little after the 1st: fall back to the previous one
    for (const edition of [month(now), month(prev)]) {
      const url = `https://download.db-ip.com/free/${name}-${edition}.mmdb.gz`;
      let res;
      try {
        res = await this.fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        last = (e as Error).message;
        continue;
      }
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        continue;
      }
      const gz = Buffer.from(await res.arrayBuffer());
      if (gz.length > MAX_GZ) throw new HarborError('OPERATION_FAILED', `the location database from DB-IP is larger than expected (${gz.length} bytes)`);
      let data: Buffer;
      try {
        data = gunzipSync(gz, { maxOutputLength: MAX_DB });
      } catch (e) {
        throw new HarborError('OPERATION_FAILED', `the location database from DB-IP could not be unpacked: ${(e as Error).message}`);
      }
      new MmdbReader(data); // refuses anything that is not a database
      return { data, edition };
    }
    throw new HarborError('OPERATION_FAILED', `the location database could not be downloaded from DB-IP (${last})`, { nextAction: 'Check that this machine can reach download.db-ip.com, then look up the address again.' });
  }

  private async refresh(): Promise<void> {
    const country = await this.download(FILES.country);
    const asn = await this.download(FILES.asn);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const [file, data] of [
      ['country.mmdb', country.data],
      ['asn.mmdb', asn.data],
    ] as const) {
      const tmp = path.join(this.dir, `${file}.tmp`);
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, path.join(this.dir, file));
    }
    writeFileSync(this.metaFile(), JSON.stringify({ edition: country.edition, downloadedAt: this.now().toISOString() }) + '\n', { mode: 0o600 });
    this.readers = { country: new MmdbReader(country.data), asn: new MmdbReader(asn.data) };
  }

  private stale(): boolean {
    const s = this.status();
    return !s.ready || !s.downloadedAt || this.now().getTime() - Date.parse(s.downloadedAt) > GEO_REFRESH_MS;
  }

  private async ensure(): Promise<void> {
    if (!this.stale()) {
      if (!this.readers) {
        try {
          this.readers = { country: new MmdbReader(readFileSync(path.join(this.dir, 'country.mmdb'))), asn: new MmdbReader(readFileSync(path.join(this.dir, 'asn.mmdb'))) };
          return;
        } catch {
          rmSync(this.metaFile(), { force: true }); // unreadable copy: download again
        }
      } else return;
    }
    this.loading ??= this.refresh().finally(() => {
      this.loading = null;
    });
    try {
      await this.loading;
    } catch (e) {
      // a stale copy still answers; only a missing one fails
      if (this.readers || this.status().ready) {
        this.readers ??= { country: new MmdbReader(readFileSync(path.join(this.dir, 'country.mmdb'))), asn: new MmdbReader(readFileSync(path.join(this.dir, 'asn.mmdb'))) };
        return;
      }
      throw e;
    }
  }

  async lookup(address: string): Promise<GeoAnswer | null> {
    await this.ensure();
    const r = this.readers!;
    return answerFrom(r.country.get(address), r.asn.get(address));
  }

  // bytes on disk (Settings shows it)
  size(): number {
    let n = 0;
    for (const f of ['country.mmdb', 'asn.mmdb']) {
      try {
        n += statSync(path.join(this.dir, f)).size;
      } catch {
        /* none */
      }
    }
    return n;
  }
}

// `pnpm dev`, tests and e2e: no download. Documentation ranges answer with clearly invented places.
export class FakeGeo implements GeoSource {
  lookups: string[] = [];
  private ready = false;
  status(): GeoStatus {
    return { ready: this.ready, edition: this.ready ? '2026-11' : null, downloadedAt: this.ready ? '2026-11-20T00:00:00.000Z' : null };
  }
  async lookup(address: string): Promise<GeoAnswer | null> {
    this.lookups.push(address);
    this.ready = true;
    const table: [string, GeoAnswer][] = [
      ['192.0.2.0/24', { country: 'NL', countryName: 'Netherlands', asn: 'AS64500', org: 'Example Hosting' }],
      ['198.51.100.0/24', { country: 'US', countryName: 'United States', asn: 'AS64501', org: 'Example Cloud' }],
      ['203.0.113.0/24', { country: 'MX', countryName: 'Mexico', asn: 'AS64502', org: 'Example Mobile' }],
      ['2001:db8::/32', { country: 'DE', countryName: 'Germany', asn: 'AS64503', org: 'Example Transit' }],
    ];
    return table.find(([r]) => contains(parseCidr(r)!, address))?.[1] ?? null;
  }
}
