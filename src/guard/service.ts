// Access Guard, daemon side (decision 207, docs/design/ACCESS_GUARD.md): the allowed list (a settings document), the
// state handed to root, the record of dropped addresses (counted from the kernel's per-source counters), tags,
// location lookups and the notifications.
//
// Changes are host-firewall settings like the VPN page's (decision 184), not app operations: they are serialized here,
// applied by root at once, and the setting only changes when root loaded it (fail closed: a failed apply keeps the
// previous list loaded and the switch where it was).
//
// The dropped-address record is a capped JSON file (<stateDir>/guard/addresses.json), not a table: no schema change,
// so going back to an older Harbor keeps working (it ignores the file).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import path from 'node:path';
import { HarborError } from '../errors.js';
import type { Ctx } from '../lifecycle/context.js';
import type { AccessGuardDto, BlockedAddressDto, GeoDto, GuardEntryDto, GuardLookupDto, OnlineLookupDto } from '../contracts/api.js';
import { instanceDir, loadReleaseSnapshot } from '../lifecycle/instance-dir.js';
import { canonicalAddress, cidrText, contains, displayCidr, EXEMPT_RANGES, isExempt, MAX_ENTRIES, parseCidr, tooWide, type GuardState } from './rules.js';
import type { GuardProvider, GuardReport } from './provider.js';
import { GEO_ATTRIBUTION, type GeoSource } from './geo.js';
import { askLookupApp } from './online.js';

export const GUARD_SETTING = 'access-guard';
// how often the daemon reads the kernel's counters while the guard is on
export const GUARD_POLL_MS = 10 * 60_000;
// dropped addresses are forgotten this long after their last packet (tagged ones are kept)
export const RETENTION_MS = 30 * 24 * 3600_000;
export const MAX_ADDRESSES = 5000;
// one address dropped this many packets since the last check: worth a notification
export const BUSY_PACKETS = 300;
export const EXPIRY_WARNING_MS = 24 * 3600_000;
const MAX_TAGS = 8;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._?-]{0,31}$/u;

export interface GuardEntry {
  id: string;
  cidr: string;
  label: string | null;
  tags: string[];
  expiresAt: string | null;
  createdAt: string;
}
export interface GuardSetting {
  enabled: boolean;
  entries: GuardEntry[];
  // the kernel holds Harbor's table (so the next start re-applies or removes it)
  applied: boolean;
}

interface AddressRecord {
  packets: number;
  firstSeen: string;
  lastSeen: string;
  // the kernel's counter at the last read (a reload starts it again at 0)
  counter: number;
  tags: string[];
  geo?: (GeoDto & { at: string }) | null;
  online?: OnlineLookupDto | null;
}
interface AddressBook {
  format: 1;
  addresses: Record<string, AddressRecord>;
}

export type Resolver = (hostname: string) => Promise<string[]>;
export const systemResolver: Resolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

function cleanTags(tags: unknown): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) throw new HarborError('INVALID_REQUEST', 'tags must be a list');
  const out: string[] = [];
  for (const t of tags) {
    const v = typeof t === 'string' ? t.trim() : '';
    if (!v) continue;
    if (!TAG_RE.test(v)) throw new HarborError('INVALID_REQUEST', `tag "${String(t).slice(0, 40)}" is not allowed`, { nextAction: 'Use up to 32 letters, digits, spaces, dots, dashes or underscores.' });
    if (!out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length > MAX_TAGS) throw new HarborError('INVALID_REQUEST', `at most ${MAX_TAGS} tags`);
  return out;
}

function cleanLabel(label: unknown): string | null {
  if (label === undefined || label === null) return null;
  if (typeof label !== 'string') throw new HarborError('INVALID_REQUEST', 'label must be text');
  const v = label.trim();
  if (v.length > 64) throw new HarborError('INVALID_REQUEST', 'the label is longer than 64 characters');
  return v || null;
}

export class GuardService {
  private chain: Promise<unknown> = Promise.resolve();
  private lastError: { message: string; at: string } | null = null;
  private appliedAt: string | null = null;
  private checkedAt: string | null = null;
  private own: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: Ctx,
    readonly provider: GuardProvider,
    readonly geo: GeoSource,
    private readonly resolver: Resolver = systemResolver,
    private readonly fetchImpl?: Parameters<typeof askLookupApp>[3],
  ) {}

  // ---------------------------------------------------------------- stored state

  setting(): GuardSetting {
    const s = this.ctx.repo.setting<Partial<GuardSetting>>(GUARD_SETTING);
    return { enabled: s?.enabled === true, entries: Array.isArray(s?.entries) ? s.entries : [], applied: s?.applied === true };
  }
  private save(next: GuardSetting): void {
    this.ctx.repo.setSetting(GUARD_SETTING, next);
  }

  private bookFile(): string {
    return path.join(this.ctx.config.stateDir, 'guard', 'addresses.json');
  }
  private book(): AddressBook {
    try {
      const d = JSON.parse(readFileSync(this.bookFile(), 'utf8')) as AddressBook;
      if (d?.format === 1 && d.addresses && typeof d.addresses === 'object') return d;
    } catch {
      /* none yet */
    }
    return { format: 1, addresses: {} };
  }
  private saveBook(b: AddressBook): void {
    const file = this.bookFile();
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const now = Date.now();
    // forget old untagged addresses, then keep the most recent ones
    const keep = Object.entries(b.addresses).filter(([, r]) => r.tags.length > 0 || now - Date.parse(r.lastSeen) < RETENTION_MS);
    keep.sort(([, x], [, y]) => (y.tags.length > 0 ? 1 : 0) - (x.tags.length > 0 ? 1 : 0) || Date.parse(y.lastSeen) - Date.parse(x.lastSeen));
    const out: AddressBook = { format: 1, addresses: Object.fromEntries(keep.slice(0, MAX_ADDRESSES)) };
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    renameSync(tmp, file);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- what root gets

  activeEntries(s = this.setting(), now = Date.now()): GuardEntry[] {
    return s.entries.filter((e) => !e.expiresAt || Date.parse(e.expiresAt) > now);
  }

  publicHostnames(): { instanceId: string; name: string; hostname: string }[] {
    const names = new Map(this.ctx.repo.listInstances().map((i) => [i.id, i.displayName ?? i.name]));
    return this.ctx.repo
      .exposures()
      .filter((e) => e.via === 'public' && e.state !== 'removing' && names.has(e.instanceId))
      .map((e) => ({ instanceId: e.instanceId, name: names.get(e.instanceId)!, hostname: e.hostname }))
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  // This machine's own public addresses: what its public names resolve to (decision 207, D5).
  async ownAddresses(): Promise<string[]> {
    const out = new Set<string>();
    for (const h of [...new Set(this.publicHostnames().map((p) => p.hostname))].slice(0, 32)) {
      try {
        const addrs = await Promise.race([this.resolver(h), new Promise<string[]>((r) => setTimeout(() => r([]), 5000))]);
        for (const a of addrs) {
          const c = canonicalAddress(a);
          if (c && !isExempt(c)) out.add(c);
        }
      } catch {
        /* a name that does not resolve adds nothing */
      }
    }
    return [...out].sort().slice(0, 16);
  }

  private async desired(s: GuardSetting): Promise<GuardState> {
    this.own = await this.ownAddresses();
    return { format: 1, allow: [...new Set(this.activeEntries(s).map((e) => e.cidr))].sort(), own: this.own };
  }

  // ---------------------------------------------------------------- counters

  // Fold the kernel's counters into the record. A counter lower than the last read means the table was reloaded.
  private absorb(report: GuardReport, now = Date.now()): { address: string; delta: number }[] {
    const b = this.book();
    const grew: { address: string; delta: number }[] = [];
    for (const s of report.seen) {
      const rec = b.addresses[s.address];
      const last = rec?.counter ?? 0;
      const delta = s.packets >= last ? s.packets - last : s.packets;
      const at = new Date(now - s.idleSeconds * 1000).toISOString();
      if (!rec) {
        if (delta === 0) continue;
        b.addresses[s.address] = { packets: delta, firstSeen: at, lastSeen: at, counter: s.packets, tags: [] };
      } else {
        rec.counter = s.packets;
        if (delta > 0) {
          rec.packets += delta;
          if (Date.parse(at) > Date.parse(rec.lastSeen)) rec.lastSeen = at;
        }
      }
      if (delta > 0) grew.push({ address: s.address, delta });
    }
    this.saveBook(b);
    this.checkedAt = new Date(now).toISOString();
    return grew;
  }

  // the kernel's counters start again at 0 after a reload or when the table goes away
  private resetCounters(): void {
    const b = this.book();
    for (const r of Object.values(b.addresses)) r.counter = 0;
    this.saveBook(b);
  }

  // ---------------------------------------------------------------- apply

  private async load(s: GuardSetting): Promise<void> {
    const avail = this.provider.available();
    if (!avail.ok) throw new HarborError('UNSUPPORTED_CAPABILITY', avail.reason ?? 'Access Guard is not supported on this machine');
    // read what the old table counted before it is replaced
    if (s.applied) await this.provider.status().then((r) => this.absorb(r), () => undefined);
    try {
      if (s.enabled) await this.provider.apply(await this.desired(s));
      else await this.provider.off();
    } catch (e) {
      this.lastError = { message: e instanceof Error ? e.message : String(e), at: this.ctx.repo.now() };
      throw e;
    }
    this.resetCounters();
    this.lastError = null;
    this.appliedAt = this.ctx.repo.now();
  }

  // Change the setting only once root loaded it.
  private change(next: GuardSetting): Promise<AccessGuardDto> {
    return this.serialize(async () => {
      const before = this.setting();
      const loadNeeded = next.enabled || before.applied;
      if (loadNeeded) await this.load({ ...next, applied: before.applied });
      this.save({ ...next, applied: next.enabled });
      return this.dto();
    });
  }

  setEnabled(enabled: boolean): Promise<AccessGuardDto> {
    const s = this.setting();
    if (s.enabled === enabled && s.applied === enabled) return Promise.resolve(this.dto());
    return this.change({ ...s, enabled });
  }

  addEntry(req: { address: string; label?: string | null; tags?: string[]; expiresAt?: string | null }): Promise<AccessGuardDto> {
    const c = parseCidr(String(req.address ?? ''));
    if (!c) throw new HarborError('INVALID_REQUEST', `${String(req.address).slice(0, 64)} is not an address or a range`, { nextAction: 'Type one address (203.0.113.7, 2001:db8::7) or a range (203.0.113.0/24, 2001:db8:4a::/64).' });
    if (tooWide(c)) throw new HarborError('INVALID_REQUEST', `${cidrText(c)} is too wide for an allowed list`, { nextAction: 'Use a narrower range, or set Access Guard to Everyone.' });
    if (EXEMPT_RANGES.some((r) => { const er = parseCidr(r)!; return er.family === c.family && er.prefix <= c.prefix && contains(er, c.address); })) {
      throw new HarborError('INVALID_REQUEST', `${displayCidr(c)} is on your own network or the tailnet, which is never dropped`, { nextAction: 'Only addresses on the internet need an entry.' });
    }
    const s = this.setting();
    if (s.entries.some((e) => e.cidr === cidrText(c))) throw new HarborError('INVALID_REQUEST', `${displayCidr(c)} is on the list already`);
    if (s.entries.length >= MAX_ENTRIES) throw new HarborError('INVALID_REQUEST', `the list holds at most ${MAX_ENTRIES} entries`);
    const entry: GuardEntry = { id: this.ctx.ids.uuid(), cidr: cidrText(c), label: cleanLabel(req.label), tags: cleanTags(req.tags), expiresAt: this.cleanExpiry(req.expiresAt), createdAt: this.ctx.repo.now() };
    return this.change({ ...s, entries: [...s.entries, entry] });
  }

  updateEntry(id: string, req: { label?: string | null; tags?: string[]; expiresAt?: string | null }): Promise<AccessGuardDto> {
    const s = this.setting();
    const e = s.entries.find((x) => x.id === id);
    if (!e) throw new HarborError('NOT_FOUND', 'no such entry');
    const next: GuardEntry = {
      ...e,
      ...(req.label !== undefined ? { label: cleanLabel(req.label) } : {}),
      ...(req.tags !== undefined ? { tags: cleanTags(req.tags) } : {}),
      ...(req.expiresAt !== undefined ? { expiresAt: this.cleanExpiry(req.expiresAt) } : {}),
    };
    const entries = s.entries.map((x) => (x.id === id ? next : x));
    // only the expiry changes what root holds
    if (next.expiresAt === e.expiresAt || !s.enabled) {
      this.save({ ...s, entries });
      this.ctx.notifier.resolve(`guard-expiring:${id}`);
      return Promise.resolve(this.dto());
    }
    return this.change({ ...s, entries });
  }

  removeEntry(id: string): Promise<AccessGuardDto> {
    const s = this.setting();
    if (!s.entries.some((x) => x.id === id)) throw new HarborError('NOT_FOUND', 'no such entry');
    this.ctx.notifier.resolve(`guard-expiring:${id}`);
    const next = { ...s, entries: s.entries.filter((x) => x.id !== id) };
    if (!s.enabled) {
      this.save(next);
      return Promise.resolve(this.dto());
    }
    return this.change(next);
  }

  private cleanExpiry(v: string | null | undefined): string | null {
    if (v === undefined || v === null || v === '') return null;
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new HarborError('INVALID_REQUEST', 'expiresAt is not a date');
    if (t <= Date.now()) throw new HarborError('INVALID_REQUEST', 'the expiry is in the past');
    if (t > Date.now() + 366 * 24 * 3600_000) throw new HarborError('INVALID_REQUEST', 'the expiry is more than a year away', { nextAction: 'Leave it empty for an entry that never expires.' });
    return new Date(t).toISOString();
  }

  // Tags on any address, dropped or not ("scanner", "me on mobile").
  tagAddress(address: string, tags: string[]): AccessGuardDto {
    const a = canonicalAddress(String(address ?? ''));
    if (!a) throw new HarborError('INVALID_REQUEST', 'tags go on one address');
    const clean = cleanTags(tags);
    const b = this.book();
    const now = this.ctx.repo.now();
    const rec = b.addresses[a];
    if (rec) rec.tags = clean;
    else if (clean.length) b.addresses[a] = { packets: 0, firstSeen: now, lastSeen: now, counter: 0, tags: clean };
    this.saveBook(b);
    return this.dto();
  }

  // ---------------------------------------------------------------- lookups

  lookupApps(): { instanceId: string; name: string; running: boolean; port: number | null; path: string }[] {
    const out = [];
    for (const inst of this.ctx.repo.listInstances()) {
      if (inst.installState !== 'installed') continue;
      let spec: { endpoint: string; path: string } | undefined;
      try {
        spec = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'release'), inst.packageId).manifest.provides?.ipLookup;
      } catch {
        continue;
      }
      if (!spec) continue;
      const port = inst.endpoints.find((e) => e.id === spec.endpoint)?.hostPort ?? null;
      out.push({ instanceId: inst.id, name: inst.displayName ?? inst.name, running: inst.runtime === 'running' && port !== null, port, path: spec.path });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async lookup(address: string, opts: { online?: boolean; instanceId?: string } = {}): Promise<GuardLookupDto> {
    const a = canonicalAddress(String(address ?? ''));
    if (!a) throw new HarborError('INVALID_REQUEST', 'look up one address');
    if (isExempt(a)) throw new HarborError('INVALID_REQUEST', `${a} is on your own network or the tailnet`, { nextAction: 'Only addresses on the internet can be looked up.' });
    const geoRaw = await this.geo.lookup(a);
    const geo: GeoDto | null = geoRaw ? { country: geoRaw.country, countryName: geoRaw.countryName, asn: geoRaw.asn, org: geoRaw.org } : null;
    let online: OnlineLookupDto | null = null;
    if (opts.online) {
      const apps = this.lookupApps().filter((x) => x.running && (!opts.instanceId || x.instanceId === opts.instanceId));
      const app = apps[0];
      if (!app || app.port === null) {
        throw new HarborError('INVALID_STATE', 'no running app answers address lookups', { nextAction: 'Install IP Lookup from the App Store (it needs the VPN), or start it.' });
      }
      try {
        const answer = await askLookupApp(app.port, app.path, a, this.fetchImpl);
        online = { instanceId: app.instanceId, app: app.name, at: this.ctx.repo.now(), note: answer.note, results: answer.results };
      } catch (e) {
        throw new HarborError('OPERATION_FAILED', `${app.name}: ${(e as Error).message}`, { nextAction: `Check ${app.name} (its log), then try again.` });
      }
    }
    const b = this.book();
    const rec = b.addresses[a];
    if (rec) {
      rec.geo = geo ? { ...geo, at: this.ctx.repo.now() } : null;
      if (online) rec.online = online;
      this.saveBook(b);
    }
    return { address: a, geo, online: online ?? rec?.online ?? null };
  }

  // ---------------------------------------------------------------- the page

  dto(): AccessGuardDto {
    const s = this.setting();
    const avail = this.provider.available();
    const now = Date.now();
    const active = this.activeEntries(s, now).map((e) => parseCidr(e.cidr)!);
    const entries: GuardEntryDto[] = s.entries.map((e) => {
      const c = parseCidr(e.cidr)!;
      return { id: e.id, address: displayCidr(c), family: c.family, label: e.label, tags: e.tags, expiresAt: e.expiresAt, expired: Boolean(e.expiresAt && Date.parse(e.expiresAt) <= now), createdAt: e.createdAt };
    });
    const book = this.book();
    const blocked: BlockedAddressDto[] = Object.entries(book.addresses)
      .map(([address, r]) => ({
        address,
        family: (address.includes(':') ? 6 : 4) as 4 | 6,
        packets: r.packets,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        tags: r.tags,
        allowed: active.some((c) => contains(c, address)),
        geo: r.geo ? { country: r.geo.country, countryName: r.geo.countryName, asn: r.geo.asn, org: r.geo.org } : null,
        online: r.online ?? null,
      }))
      .sort((x, y) => y.packets - x.packets || Date.parse(y.lastSeen) - Date.parse(x.lastSeen));
    const geo = this.geo.status();
    return {
      available: avail.ok,
      reason: avail.reason,
      enabled: s.enabled,
      state: this.lastError ? 'failed' : s.applied ? 'on' : 'off',
      message: this.lastError?.message ?? null,
      appliedAt: this.appliedAt,
      checkedAt: this.checkedAt,
      entries,
      exempt: [...EXEMPT_RANGES, 'tailscale0'],
      own: this.own,
      publicApps: this.publicHostnames(),
      blocked,
      totals: {
        addresses: blocked.filter((x) => x.packets > 0).length,
        packets: blocked.reduce((n, x) => n + x.packets, 0),
        addresses24h: blocked.filter((x) => x.packets > 0 && now - Date.parse(x.lastSeen) < 24 * 3600_000).length,
      },
      geo: { ...geo, attribution: { ...GEO_ATTRIBUTION } },
      lookupApps: this.lookupApps().map(({ instanceId, name, running }) => ({ instanceId, name, running })),
    };
  }

  // ---------------------------------------------------------------- the periodic check

  // Read the counters, drop expired entries, follow a changed public address, notify. Root is only asked while the
  // guard is on.
  check(): Promise<AccessGuardDto> {
    return this.serialize(async () => {
      const s = this.setting();
      if (!s.enabled || !s.applied) return this.dto();
      const now = Date.now();
      let grew: { address: string; delta: number }[] = [];
      try {
        grew = this.absorb(await this.provider.status(), now);
      } catch (e) {
        this.ctx.log.warn(`access guard: reading the counters failed: ${(e as Error).message}`);
      }
      // expired entries leave the kernel's list; a changed public address joins it
      const expired = s.entries.filter((e) => e.expiresAt && Date.parse(e.expiresAt) <= now);
      const own = await this.ownAddresses();
      if (expired.length || own.join() !== this.own.join()) {
        const next = { ...s, entries: s.entries.filter((e) => !expired.includes(e)) };
        try {
          await this.load(next);
          this.save({ ...next, applied: true });
          for (const e of expired) this.ctx.notifier.resolve(`guard-expiring:${e.id}`);
        } catch (e) {
          this.ctx.log.error(`access guard: could not reload the list: ${(e as Error).message}`);
        }
      }
      this.notify(grew, now);
      return this.dto();
    });
  }

  private notify(grew: { address: string; delta: number }[], now: number): void {
    const book = this.book();
    const busy = grew.filter((g) => g.delta >= BUSY_PACKETS && !(book.addresses[g.address]?.tags.length)).sort((a, b) => b.delta - a.delta);
    if (busy.length) {
      const top = busy[0]!;
      this.ctx.notifier.notify({
        kind: 'guard-busy',
        severity: 'info',
        title: busy.length === 1 ? `${top.address} keeps trying to reach your public apps` : `${busy.length} addresses keep trying to reach your public apps`,
        body: `${top.address} sent ${top.delta} packets since the last check${busy.length > 1 ? `, the most of ${busy.length}` : ''}. Access Guard dropped them all. Tag the address in Settings → Allowed addresses to stop hearing about it.`,
        dedupeKey: 'guard-busy',
      });
    } else this.ctx.notifier.resolve('guard-busy');
    for (const e of this.setting().entries) {
      if (!e.expiresAt) continue;
      const left = Date.parse(e.expiresAt) - now;
      if (left > 0 && left <= EXPIRY_WARNING_MS) {
        this.ctx.notifier.notify({
          kind: 'guard-expiring',
          severity: 'info',
          title: `${e.label ?? displayCidr(parseCidr(e.cidr)!)} stops being allowed soon`,
          body: `Its entry in Settings → Allowed addresses expires ${new Date(e.expiresAt).toUTCString()}. Change its expiry there to keep it.`,
          dedupeKey: `guard-expiring:${e.id}`,
        });
      }
    }
  }

  // Daemon start: put the kernel in line with the setting (the boot unit already loaded the last list), then check
  // every GUARD_POLL_MS.
  async start(intervalMs = GUARD_POLL_MS): Promise<void> {
    const s = this.setting();
    if (s.enabled || s.applied) {
      await this.serialize(async () => {
        await this.load(s);
        this.save({ ...s, applied: s.enabled });
      }).catch((e: Error) => this.ctx.log.error(`access guard: the allowed list could not be loaded at startup: ${e.message}`));
    }
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.check().catch((e: Error) => this.ctx.log.warn(`access guard check failed: ${e.message}`)), intervalMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
