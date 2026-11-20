// Access Guard (decision 207, docs/design/ACCESS_GUARD.md): drop every connection to the public apps (Caddy's
// :443, TCP and QUIC) unless it comes from an allowed address. PURE: address parsing, the state root is handed,
// the nftables ruleset and the parser for the counters root reads back. No I/O.
//
// Proven on Ubuntu 24.04's nft 1.0.9 (a container on Docker Desktop, 2026-11-20): an allowed source gets through,
// any other is dropped silently, and the dynamic `seen` sets keep a packet counter per source (`nft -j list set`).
// Counters are packets, not tries: a dropped client resends its first packet, so one try counts ~2–3.
import { isIP } from 'node:net';
import { HarborError } from '../errors.js';

export const GUARD_FAMILY = 'inet';
export const GUARD_TABLE = 'harbor_guard';
// Caddy serves every public app on 443 (TCP, and UDP for HTTP/3). Port 80 stays open: Let's Encrypt validates from
// addresses it does not publish, and Caddy only redirects or answers certificate checks there.
export const GUARD_PORT = 443;
// Never dropped (decision 207, D5): loopback, the LAN, link-local, Tailscale's range (tailnet traffic also arrives
// on tailscale0), Docker's own networks (inside 10/8 and 172.16/12) and IPv6 unique-local/link-local.
export const EXEMPT_RANGES = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10'] as const;
export const EXEMPT_INTERFACES = ['lo', 'tailscale0'] as const;
// How long root keeps a source's counter after its last packet, and how many sources each family keeps.
export const SEEN_TIMEOUT_S = 7 * 24 * 3600;
export const SEEN_SIZE = 65535;
export const MAX_ENTRIES = 1024;

export interface Cidr {
  family: 4 | 6;
  // the network address, canonical (host bits zeroed, IPv6 in RFC 5952 form)
  address: string;
  prefix: number;
}

// ---------------------------------------------------------------- addresses

function v4ToBytes(a: string): number[] {
  return a.split('.').map(Number);
}

function v6ToBytes(a: string): number[] | null {
  let s = a.toLowerCase();
  // an embedded IPv4 tail (::ffff:192.0.2.1)
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  let v4: number[] = [];
  if (tail) {
    if (isIP(tail[1]!) !== 4) return null;
    v4 = v4ToBytes(tail[1]!);
    s = s.slice(0, -tail[1]!.length) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail) bytes.splice(12, 4, ...v4);
  return bytes;
}

function bytesToV6(b: number[]): string {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((b[i]! << 8) | b[i + 1]!).toString(16));
  // RFC 5952: the longest run of two or more zero groups becomes ::
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  if (best.len < 2) return groups.join(':');
  return `${groups.slice(0, best.at).join(':')}::${groups.slice(best.at + best.len).join(':')}`;
}

function maskBytes(b: number[], prefix: number): number[] {
  return b.map((x, i) => {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    return bits === 8 ? x : x & ((0xff << (8 - bits)) & 0xff);
  });
}

// An address or a range the operator types: `203.0.113.7`, `203.0.113.0/24`, `2001:db8:4a::/64`. Host bits are
// zeroed (`203.0.113.7/24` becomes `203.0.113.0/24`). null = not an address.
export function parseCidr(input: string): Cidr | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const m = /^([0-9A-Fa-f:.]+)(?:\/(\d{1,3}))?$/.exec(input.trim());
  if (!m) return null;
  const family = isIP(m[1]!);
  if (family !== 4 && family !== 6) return null;
  const max = family === 4 ? 32 : 128;
  const prefix = m[2] === undefined ? max : Number(m[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  if (family === 4) {
    const b = maskBytes(v4ToBytes(m[1]!), prefix);
    return { family: 4, address: b.join('.'), prefix };
  }
  const bytes = v6ToBytes(m[1]!);
  if (!bytes) return null;
  return { family: 6, address: bytesToV6(maskBytes(bytes, prefix)), prefix };
}

export function cidrText(c: Cidr): string {
  return `${c.address}/${c.prefix}`;
}

// How an entry is shown: a single address without its /32 or /128.
export function displayCidr(c: Cidr): string {
  return c.prefix === (c.family === 4 ? 32 : 128) ? c.address : cidrText(c);
}

// The canonical form of a single address (what counters and tags are keyed by). null = not one address.
export function canonicalAddress(input: string): string | null {
  const c = parseCidr(input);
  if (!c || c.prefix !== (c.family === 4 ? 32 : 128) || input.includes('/')) return null;
  return c.address;
}

function cidrBytes(c: Cidr): number[] {
  return c.family === 4 ? v4ToBytes(c.address) : v6ToBytes(c.address)!;
}

// Is `address` (one address) inside `range`?
export function contains(range: Cidr, address: string): boolean {
  const a = parseCidr(address);
  if (!a || a.family !== range.family) return false;
  return maskBytes(cidrBytes(a), range.prefix).every((x, i) => x === cidrBytes(range)[i]);
}

// Ranges so wide they mean "everyone": refused, the switch for that is Everyone.
export function tooWide(c: Cidr): boolean {
  return c.family === 4 ? c.prefix < 8 : c.prefix < 16;
}

export function isExempt(address: string): boolean {
  return EXEMPT_RANGES.some((r) => contains(parseCidr(r)!, address));
}

// ---------------------------------------------------------------- what root loads

export interface GuardState {
  format: 1;
  // the allowed list, canonical CIDRs
  allow: string[];
  // this machine's own public addresses (decision 207, D5: routers that send LAN traffic back in through them)
  own: string[];
}

// Root trusts nothing it is handed: every value goes into an nft script, so each one is re-parsed here.
export function validateGuardState(doc: unknown): GuardState {
  const fail = (m: string) => new HarborError('INVALID_REQUEST', `access guard state: ${m}`);
  if (!doc || typeof doc !== 'object') throw fail('not an object');
  const d = doc as { format?: unknown; allow?: unknown; own?: unknown };
  if (d.format !== 1) throw fail('unknown format');
  const list = (v: unknown, what: string, max: number, single: boolean): string[] => {
    if (!Array.isArray(v) || v.length > max) throw fail(`${what} must be a list of at most ${max}`);
    const out = new Set<string>();
    for (const x of v) {
      const c = typeof x === 'string' ? parseCidr(x) : null;
      if (!c) throw fail(`${what}: ${String(x).slice(0, 64)} is not an address or range`);
      if (single && c.prefix !== (c.family === 4 ? 32 : 128)) throw fail(`${what}: ${String(x)} must be one address`);
      if (tooWide(c)) throw fail(`${what}: ${String(x)} is too wide`);
      out.add(cidrText(c));
    }
    return [...out].sort();
  };
  return { format: 1, allow: list(d.allow, 'allow', MAX_ENTRIES, false), own: list(d.own, 'own', 16, true) };
}

function elements(cidrs: string[], family: 4 | 6): string {
  const mine = cidrs.filter((c) => parseCidr(c)!.family === family);
  return mine.length ? ` elements = { ${mine.join(', ')} };` : '';
}

// The whole table, loaded with `nft -f` in one transaction (an older copy is deleted first; the empty `table … {}`
// line makes that delete valid when there is none). Root keeps the text that loaded as the boot copy.
export function guardRuleset(state: GuardState): string {
  const exempt = [...EXEMPT_RANGES, ...state.own];
  const set = (name: string, type: string, items: string[], family: 4 | 6) => `  set ${name} { type ${type}; flags interval; auto-merge;${elements(items, family)} }`;
  return [
    `table ${GUARD_FAMILY} ${GUARD_TABLE} {}`,
    `delete table ${GUARD_FAMILY} ${GUARD_TABLE}`,
    `table ${GUARD_FAMILY} ${GUARD_TABLE} {`,
    set('exempt4', 'ipv4_addr', exempt, 4),
    set('exempt6', 'ipv6_addr', exempt, 6),
    set('allow4', 'ipv4_addr', state.allow, 4),
    set('allow6', 'ipv6_addr', state.allow, 6),
    `  set seen4 { type ipv4_addr; size ${SEEN_SIZE}; flags dynamic,timeout; timeout ${SEEN_TIMEOUT_S}s; counter; }`,
    `  set seen6 { type ipv6_addr; size ${SEEN_SIZE}; flags dynamic,timeout; timeout ${SEEN_TIMEOUT_S}s; counter; }`,
    '  chain guard_input {',
    '    type filter hook input priority filter - 10; policy accept;',
    `    meta l4proto != { tcp, udp } accept`,
    `    th dport != ${GUARD_PORT} accept`,
    `    iifname { ${EXEMPT_INTERFACES.map((i) => `"${i}"`).join(', ')} } accept`,
    '    ip saddr @exempt4 accept',
    '    ip6 saddr @exempt6 accept',
    '    ip saddr @allow4 accept',
    '    ip6 saddr @allow6 accept',
    '    ct state new update @seen4 { ip saddr }',
    '    ct state new update @seen6 { ip6 saddr }',
    '    drop comment "harbor access guard"',
    '  }',
    '}',
    '',
  ].join('\n');
}

export function guardDeleteScript(): string {
  return `table ${GUARD_FAMILY} ${GUARD_TABLE} {}\ndelete table ${GUARD_FAMILY} ${GUARD_TABLE}\n`;
}

// ---------------------------------------------------------------- what root reads back

export interface SeenSource {
  address: string;
  packets: number;
  // seconds since its last dropped packet (the set's timeout minus what is left of it)
  idleSeconds: number;
}

// `nft -j list set inet harbor_guard seen4|seen6` → sources. Anything unexpected is skipped, never trusted.
export function parseSeenJson(text: string): SeenSource[] {
  let doc: { nftables?: unknown[] };
  try {
    doc = JSON.parse(text) as { nftables?: unknown[] };
  } catch {
    return [];
  }
  const out: SeenSource[] = [];
  for (const item of doc.nftables ?? []) {
    const set = (item as { set?: { timeout?: number; elem?: unknown[] } }).set;
    if (!set || !Array.isArray(set.elem)) continue;
    const timeout = typeof set.timeout === 'number' ? set.timeout : SEEN_TIMEOUT_S;
    for (const e of set.elem) {
      const el = (e as { elem?: { val?: unknown; expires?: unknown; counter?: { packets?: unknown } } }).elem;
      const address = typeof el?.val === 'string' ? canonicalAddress(el.val) : null;
      const packets = el?.counter?.packets;
      if (!address || typeof packets !== 'number' || !Number.isFinite(packets) || packets < 0) continue;
      const expires = typeof el?.expires === 'number' ? el.expires : timeout;
      out.push({ address, packets, idleSeconds: Math.max(0, timeout - expires) });
    }
  }
  return out;
}
