// Decision 207 (Access Guard), PURE parts: addresses, the state root re-validates, the nft ruleset, the counters root
// reads back (a real `nft -j` answer from Ubuntu 24.04's nft 1.0.9), the MaxMind DB reader (against a tiny database
// written here) and what Harbor keeps of a lookup app's answer (decision 209).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalAddress, contains, displayCidr, guardDeleteScript, guardRuleset, isExempt, parseCidr, parseSeenJson, tooWide, validateGuardState } from '../../src/guard/rules.js';
import { parseGuardStatus } from '../../src/guard/provider.js';
import { MmdbReader } from '../../src/guard/mmdb.js';
import { sanitizeOnlineAnswer } from '../../src/guard/online.js';
import { guardBootUnit, guardStepUnit, polkitPowerRule } from '../../src/bootstrap/systemd.js';

describe('addresses', () => {
  it('parses, zeroes host bits and writes IPv6 in its short form', () => {
    expect(parseCidr('203.0.113.7')).toEqual({ family: 4, address: '203.0.113.7', prefix: 32 });
    expect(parseCidr('203.0.113.7/24')).toEqual({ family: 4, address: '203.0.113.0', prefix: 24 });
    expect(parseCidr(' 2001:DB8:4A10:0:0:0:0:1/64 ')).toEqual({ family: 6, address: '2001:db8:4a10::', prefix: 64 });
    expect(parseCidr('2001:db8::1')).toEqual({ family: 6, address: '2001:db8::1', prefix: 128 });
    expect(parseCidr('::ffff:192.0.2.1')).toEqual({ family: 6, address: '::ffff:c000:201', prefix: 128 });
    expect(parseCidr('2001:0:0:1:0:0:0:1')?.address).toBe('2001:0:0:1::1'); // the longest zero run
    expect(parseCidr('1:0:0:2:0:0:0:3')?.address).toBe('1:0:0:2::3');
    for (const bad of ['', 'x', '203.0.113.7/33', '2001:db8::/129', '203.0.113', '1.2.3.4/', '2001:db8:::1', 'a'.repeat(80), '203.0.113.7 /24']) expect(parseCidr(bad), bad).toBeNull();
  });
  it('single addresses, display, ranges', () => {
    expect(canonicalAddress('2001:DB8::0001')).toBe('2001:db8::1');
    expect(canonicalAddress('203.0.113.7/32')).toBeNull();
    expect(displayCidr(parseCidr('203.0.113.7')!)).toBe('203.0.113.7');
    expect(displayCidr(parseCidr('2001:db8:4a::/64')!)).toBe('2001:db8:4a::/64');
    expect(contains(parseCidr('2001:db8:4a::/48')!, '2001:db8:4a:1::9')).toBe(true);
    expect(contains(parseCidr('2001:db8:4a::/48')!, '2001:db8:4b::9')).toBe(false);
    expect(contains(parseCidr('203.0.113.0/24')!, '2001:db8::1')).toBe(false);
    expect(tooWide(parseCidr('10.0.0.0/7')!)).toBe(true);
    expect(tooWide(parseCidr('2001::/15')!)).toBe(true);
    expect(tooWide(parseCidr('2001:db8::/16')!)).toBe(false);
    for (const a of ['127.0.0.1', '10.200.4.5', '172.20.0.1', '192.168.1.9', '100.100.1.1', '::1', 'fd00::5', 'fe80::1']) expect(isExempt(a), a).toBe(true);
    for (const a of ['203.0.113.7', '172.32.0.1', '2001:db8::1', '100.128.0.1']) expect(isExempt(a), a).toBe(false);
  });
});

describe('what root is handed', () => {
  it('re-validates and normalises every value', () => {
    expect(validateGuardState({ format: 1, allow: ['203.0.113.7', '203.0.113.7/32', '2001:DB8::/64'], own: ['198.51.100.4'] })).toEqual({ format: 1, allow: ['2001:db8::/64', '203.0.113.7/32'], own: ['198.51.100.4/32'] });
    expect(() => validateGuardState({ format: 2, allow: [], own: [] })).toThrow(/unknown format/);
    expect(() => validateGuardState({ format: 1, allow: ['1.2.3.4; flush ruleset'], own: [] })).toThrow(/not an address/);
    expect(() => validateGuardState({ format: 1, allow: ['0.0.0.0/0'], own: [] })).toThrow(/too wide/);
    expect(() => validateGuardState({ format: 1, allow: [], own: ['198.51.100.0/24'] })).toThrow(/one address/);
    expect(() => validateGuardState({ format: 1, allow: Array.from({ length: 1025 }, (_, i) => `10.${i >> 8}.${i & 255}.1`), own: [] })).toThrow(/at most 1024/);
  });
  it('renders one table: exemptions, the list, counting sets, then drop on 443', () => {
    const text = guardRuleset({ format: 1, allow: ['203.0.113.24/32', '2001:db8:4a10::/64'], own: ['198.51.100.4/32'] });
    expect(text.split('\n').slice(0, 3)).toEqual(['table inet harbor_guard {}', 'delete table inet harbor_guard', 'table inet harbor_guard {']);
    expect(text).toContain('set allow4 { type ipv4_addr; flags interval; auto-merge; elements = { 203.0.113.24/32 }; }');
    expect(text).toContain('set allow6 { type ipv6_addr; flags interval; auto-merge; elements = { 2001:db8:4a10::/64 }; }');
    expect(text).toMatch(/set exempt4 \{[^}]*elements = \{ 127\.0\.0\.0\/8, [^}]*198\.51\.100\.4\/32 \}/);
    expect(text).toContain('set seen4 { type ipv4_addr; size 65535; flags dynamic,timeout; timeout 604800s; counter; }');
    const chain = text.slice(text.indexOf('chain guard_input'));
    const order = ['th dport != 443 accept', 'iifname { "lo", "tailscale0" } accept', 'ip saddr @exempt4 accept', 'ip saddr @allow4 accept', 'update @seen4', 'drop comment "harbor access guard"'].map((s) => chain.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // an empty list has no elements line (nft refuses `elements = { }`)
    expect(guardRuleset({ format: 1, allow: [], own: [] })).toContain('set allow4 { type ipv4_addr; flags interval; auto-merge; }');
    expect(guardDeleteScript()).toBe('table inet harbor_guard {}\ndelete table inet harbor_guard\n');
  });
  it('reads the per-source counters nft 1.0.9 printed', () => {
    const text = readFileSync(path.join(__dirname, '../fixtures/nft-guard-seen4.json'), 'utf8');
    expect(parseSeenJson(text)).toEqual([
      { address: '172.30.9.30', packets: 6, idleSeconds: 4 },
      { address: '172.30.9.31', packets: 2, idleSeconds: 2 },
    ]);
    expect(parseSeenJson('not json')).toEqual([]);
    expect(parseSeenJson(JSON.stringify({ nftables: [{ set: { timeout: 10, elem: [{ elem: { val: 'x; drop', counter: { packets: 1 } } }, { elem: { val: '203.0.113.1', counter: { packets: -1 } } }] } }] }))).toEqual([]);
  });
  it('a status file from root is checked before it is believed', () => {
    const s = parseGuardStatus(JSON.stringify({ action: 'status', state: 'ok', message: 'ok', at: 'x', report: { loaded: true, allowed: 2, seen: [{ address: '203.0.113.1', packets: 3, idleSeconds: 1 }, { address: '203.0.113.001', packets: 1, idleSeconds: 1 }, { address: 'nope', packets: 1, idleSeconds: 1 }] } }));
    expect(s?.report?.seen).toEqual([{ address: '203.0.113.1', packets: 3, idleSeconds: 1 }]);
    expect(parseGuardStatus('{}')).toBeNull();
  });
  it('units: the step is a oneshot; Caddy requires the boot copy; polkit lets the daemon start only harbor-guard@', () => {
    expect(guardStepUnit()).toContain('ExecStart=/opt/harbor/bin/harbor guard-step %i');
    const boot = guardBootUnit();
    expect(boot).toContain('Before=caddy.service');
    expect(boot).toContain('RequiredBy=caddy.service');
    expect(boot).toContain('ConditionPathExists=/etc/harbor/guard/rules.nft');
    expect(boot).toContain('ExecStart=/usr/sbin/nft -f /etc/harbor/guard/rules.nft');
    expect(polkitPowerRule()).toContain('indexOf("harbor-guard@") === 0');
  });
});

// ---------------------------------------------------------------- a tiny MaxMind DB

function enc(v: unknown): Buffer {
  const head = (type: number, size: number): Buffer => {
    const ext = type > 7;
    const ctrl = ((ext ? 0 : type) << 5) | (size < 29 ? size : 29);
    return Buffer.from([ctrl, ...(ext ? [type - 7] : []), ...(size >= 29 ? [size - 29] : [])]);
  };
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(2, b.length), b]);
  }
  if (typeof v === 'number') {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    const trimmed = b.subarray(b.findIndex((x) => x !== 0) === -1 ? 4 : b.findIndex((x) => x !== 0));
    return Buffer.concat([head(6, trimmed.length), trimmed]);
  }
  if (Array.isArray(v)) return Buffer.concat([head(11, v.length), ...v.map(enc)]);
  const entries = Object.entries(v as Record<string, unknown>);
  return Buffer.concat([head(7, entries.length), ...entries.flatMap(([k, x]) => [enc(k), enc(x)])]);
}

// An IPv6 tree (24-bit records) holding IPv4 networks under ::/96, as DB-IP's files do.
function writeMmdb(networks: [string, number, Record<string, unknown>][]): Buffer {
  type Node = { kids: [Node | number | null, Node | number | null] };
  const root: Node = { kids: [null, null] };
  const datas: Buffer[] = [];
  const offsets: number[] = [];
  let at = 0;
  for (const [, , d] of networks) {
    offsets.push(at);
    const b = enc(d);
    datas.push(b);
    at += b.length;
  }
  networks.forEach(([addr, prefix], i) => {
    const bits = [...Array<number>(96).fill(0), ...addr.split('.').flatMap((o) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (Number(o) >> s) & 1))].slice(0, 96 + prefix);
    let n = root;
    bits.forEach((b, j) => {
      if (j === bits.length - 1) n.kids[b as 0 | 1] = -(i + 1);
      else {
        const k = n.kids[b as 0 | 1];
        if (k === null || typeof k === 'number') n.kids[b as 0 | 1] = { kids: [null, null] };
        n = n.kids[b as 0 | 1] as Node;
      }
    });
  });
  const nodes: Node[] = [];
  const walk = (n: Node) => {
    nodes.push(n);
    for (const k of n.kids) if (k && typeof k !== 'number') walk(k);
  };
  walk(root);
  const count = nodes.length;
  const rec = (k: Node | number | null) => (k === null ? count : typeof k === 'number' ? count + 16 + offsets[-k - 1]! : nodes.indexOf(k));
  const tree = Buffer.alloc(count * 6);
  nodes.forEach((n, i) => {
    tree.writeUIntBE(rec(n.kids[0]), i * 6, 3);
    tree.writeUIntBE(rec(n.kids[1]), i * 6 + 3, 3);
  });
  const meta = enc({ node_count: count, record_size: 24, ip_version: 6, database_type: 'Test', binary_format_major_version: 2, binary_format_minor_version: 0, build_epoch: 1, languages: ['en'], description: { en: 'test' } });
  return Buffer.concat([tree, Buffer.alloc(16), ...datas, Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com'), meta]);
}

describe('MaxMind DB reader', () => {
  const db = writeMmdb([
    ['203.0.113.0', 24, { country: { iso_code: 'MX', names: { en: 'Mexico' } } }],
    ['198.51.100.0', 25, { autonomous_system_number: 64501, autonomous_system_organization: 'Example Cloud' }],
  ]);
  const r = new MmdbReader(db);
  it('reads the metadata and finds IPv4 networks under ::/96', () => {
    expect(r.metadata).toMatchObject({ recordSize: 24, ipVersion: 6, databaseType: 'Test' });
    expect(r.get('203.0.113.77')).toEqual({ country: { iso_code: 'MX', names: { en: 'Mexico' } } });
    expect(r.get('198.51.100.5')).toEqual({ autonomous_system_number: 64501, autonomous_system_organization: 'Example Cloud' });
    expect(r.get('198.51.100.200')).toBeNull(); // outside the /25
    expect(r.get('192.0.2.1')).toBeNull();
    expect(r.get('::ffff:203.0.113.9')).toBeNull(); // IPv4-mapped is a different branch than ::/96
  });
  it('refuses what is not a database', () => {
    expect(() => new MmdbReader(Buffer.from('hello'))).toThrow(/no metadata/);
    expect(() => r.get('not an ip')).toThrow(/not an address/);
  });
});

describe('a lookup app\'s answer (decision 209)', () => {
  it('keeps known fields only, cut to size', () => {
    const a = sanitizeOnlineAnswer({
      format: 1,
      note: 'n',
      results: [
        { source: 'ipinfo', ok: true, country: 'US', city: 'x'.repeat(300), asn: 'AS1', abuseScore: 101, flags: ['vpn', 'vpn', 'evil'], extra: 1 },
        { source: 'bad source!', ok: true },
        { source: 'abuseipdb', ok: false },
        { source: 'abuseipdb', ok: true, abuseScore: 55, lastReportedAt: 'not a date', reports: 3 },
      ],
    });
    expect(a).toEqual({
      note: 'n',
      results: [
        { source: 'ipinfo', ok: true, country: 'US', city: 'x'.repeat(120), asn: 'AS1', flags: ['vpn'] },
        { source: 'abuseipdb', ok: false, error: 'failed' },
        { source: 'abuseipdb', ok: true, abuseScore: 55, reports: 3 },
      ],
    });
    expect(() => sanitizeOnlineAnswer({ format: 2, results: [] })).toThrow(/format/);
  });
});
