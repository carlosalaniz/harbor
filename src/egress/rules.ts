// Host rules for VPN and offline apps (decision 184, docs/design/VPN.md §2). PURE: builds the nftables ruleset and
// the `ip` argument lists the root step runs, and validates what the daemon asks for. No I/O.
import { isIP } from 'node:net';
import { HarborError } from '../errors.js';
import { UUID_RE } from '../contracts/patterns.js';
import { parseCidr } from './wireguard.js';

export type EgressMode = 'vpn' | 'offline';
export type InternetMode = 'direct' | EgressMode;
export const INTERNET_MODES: readonly InternetMode[] = ['direct', 'vpn', 'offline'];

export const TUNNEL_IF = 'hb-vpn0';
export const NFT_FAMILY = 'inet';
export const NFT_TABLE = 'harbor_egress';
export const ROUTE_TABLE = 4842;
export const MARK_MASK = 0x0f000000;
export const MARK_VPN = 0x01000000;
export const MARK_OFFLINE = 0x02000000;
export const RULE_PRIORITY = { dns: 5160, local: 5170, tunnel: 5180 } as const;
// Addresses a VPN app may reach without the tunnel: the operator's own network (and Docker's), never the internet.
export const LOCAL_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10'] as const;

// Docker's embedded resolver forwards an app's lookups from the HOST's network namespace (Docker 29, seen live:
// the queries leave with the host's own address, nothing crosses the app's bridge), so the app's subnet never
// shows on them. Harbor therefore renders a resolver into non-direct apps (`dns:` in their Compose services):
// - VPN apps ask VPN_DNS_ADDRESS, a documentation address (TEST-NET-2) that never leaves this machine: the
//   output path marks the host's queries to it as VPN and rewrites them to the tunnel's resolver, so they go
//   through the tunnel (or are refused at once while there is none). It stays the same when the tunnel changes.
// - Offline apps ask OFFLINE_DNS_ADDRESS, a loopback address nothing listens on: refused on the spot, nothing
//   leaves (an offline app cannot even send a query name out).
export const VPN_DNS_ADDRESS = '198.51.100.53';
export const OFFLINE_DNS_ADDRESS = '127.0.53.53';
export function renderedDns(mode: InternetMode): string[] | null {
  return mode === 'vpn' ? [VPN_DNS_ADDRESS] : mode === 'offline' ? [OFFLINE_DNS_ADDRESS] : null;
}

export interface EgressApp {
  instanceId: string;
  mode: EgressMode;
  // the IPv4 subnets of the app's own network(s)
  subnets: string[];
}

export interface EgressState {
  format: 1;
  apps: EgressApp[];
}

const hex = (n: number) => `0x${n.toString(16).padStart(8, '0')}`;

// A subnet Docker gave an app network: a private IPv4 range, /8 to /30, written as its network address.
export function isAppSubnet(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const c = parseCidr(v);
  if (!c || c.family !== 4 || !v.includes('/') || c.prefix < 8 || c.prefix > 30) return false;
  const n = ipv4ToInt(c.address);
  if (((n >>> 0) & prefixMask(c.prefix)) >>> 0 !== n >>> 0) return false; // host bits set: not a network address
  return LOCAL_RANGES.slice(0, 3).some((r) => within(v, r));
}

function ipv4ToInt(a: string): number {
  return a.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);
}
function prefixMask(p: number): number {
  return p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
}
// is CIDR `inner` entirely inside CIDR `outer` (IPv4)?
export function within(inner: string, outer: string): boolean {
  const i = parseCidr(inner);
  const o = parseCidr(outer);
  if (!i || !o || i.family !== 4 || o.family !== 4 || i.prefix < o.prefix) return false;
  return ((ipv4ToInt(i.address) & prefixMask(o.prefix)) >>> 0) === ((ipv4ToInt(o.address) & prefixMask(o.prefix)) >>> 0);
}

// The root step trusts nothing it is handed: every value goes into an nft script, so each one is checked
// against a fixed pattern here, and two apps may not claim overlapping subnets.
export function validateEgressState(doc: unknown): EgressState {
  const fail = (m: string) => new HarborError('INVALID_REQUEST', `egress state: ${m}`);
  if (!doc || typeof doc !== 'object') throw fail('not an object');
  const d = doc as { format?: unknown; apps?: unknown };
  if (d.format !== 1) throw fail('unknown format');
  if (!Array.isArray(d.apps) || d.apps.length > 512) throw fail('apps must be a list');
  const apps: EgressApp[] = [];
  const seen: string[] = [];
  for (const a of d.apps as unknown[]) {
    const r = a as Partial<EgressApp>;
    if (!r || typeof r !== 'object' || typeof r.instanceId !== 'string' || !UUID_RE.test(r.instanceId)) throw fail('bad instance id');
    if (r.mode !== 'vpn' && r.mode !== 'offline') throw fail(`bad mode for ${r.instanceId}`);
    if (!Array.isArray(r.subnets) || !r.subnets.length || r.subnets.length > 8 || !r.subnets.every(isAppSubnet)) throw fail(`bad subnets for ${r.instanceId}`);
    for (const s of r.subnets) {
      if (seen.some((o) => within(s, o) || within(o, s))) throw fail(`subnet ${s} is claimed twice`);
      seen.push(s);
    }
    apps.push({ instanceId: r.instanceId, mode: r.mode, subnets: [...r.subnets] });
  }
  apps.sort((x, y) => x.instanceId.localeCompare(y.instanceId));
  return { format: 1, apps };
}

export function isDnsServer(v: unknown): v is string {
  return typeof v === 'string' && isIP(v) === 4;
}

// The whole table, loaded with `nft -f` in one transaction: an older copy is deleted first (the `table … {}` line
// makes the delete valid when there is none), so the kernel never sees half a ruleset.
// Root also writes it to /etc/harbor/egress/rules.nft once it loaded live; the boot unit loads that file before Docker.
export function nftRuleset(state: EgressState, opts: { dns: string | null; tunnel: boolean }): string {
  if (opts.dns !== null && !isDnsServer(opts.dns)) throw new HarborError('INVALID_REQUEST', `egress: bad DNS server ${String(opts.dns)}`);
  const vpnMark = `meta mark & ${hex(MARK_MASK)} == ${hex(MARK_VPN)}`;
  const offMark = `meta mark & ${hex(MARK_MASK)} == ${hex(MARK_OFFLINE)}`;
  const setMark = (m: number) => `meta mark set meta mark & ${hex(~MARK_MASK >>> 0)} | ${hex(m)}`;
  const mark: string[] = [];
  for (const app of state.apps) {
    for (const s of app.subnets) {
      const m = setMark(app.mode === 'vpn' ? MARK_VPN : MARK_OFFLINE);
      mark.push(`    ip saddr ${s} ip daddr != ${s} ct direction original ${m} comment "${app.instanceId} ${app.mode}"`);
      // its own bridge's gateway is this machine (seen live: an offline app reached another app's published port
      // through it): anything addressed to this machine counts as outside the app, whatever its subnet
      mark.push(`    ip saddr ${s} fib daddr type local ct direction original ${m} comment "${app.instanceId} ${app.mode} to this machine"`);
    }
  }
  // With a tunnel, a VPN app's lookup goes to the tunnel's resolver. Without one it is turned to this machine and
  // refused there with port-unreachable: Docker's resolver ignores host/net-unreachable and waited out ~32 s per
  // lookup (seen live), a refused port answers at once. Nothing leaves either way.
  const dnat = opts.dns
    ? [`    ${vpnMark} udp dport 53 dnat ip to ${opts.dns}`, `    ${vpnMark} tcp dport 53 dnat ip to ${opts.dns}`]
    : [`    ${vpnMark} udp dport 53 redirect`, `    ${vpnMark} tcp dport 53 redirect`];
  const local = `{ ${LOCAL_RANGES.join(', ')} }`;
  const forward = [
    `    ${offMark} reject with icmpx admin-prohibited comment "offline"`,
    ...(opts.tunnel ? [`    ${vpnMark} oifname "${TUNNEL_IF}" tcp flags syn tcp option maxseg size set rt mtu`, `    ${vpnMark} oifname "${TUNNEL_IF}" accept`] : []),
    `    ${vpnMark} th dport 53 reject with icmpx admin-prohibited comment "dns outside the tunnel"`,
    `    ${vpnMark} ip daddr ${local} accept comment "this network"`,
    `    ${vpnMark} reject with icmpx admin-prohibited comment "kill switch"`,
  ];
  return [
    `table ${NFT_FAMILY} ${NFT_TABLE} {}`,
    `delete table ${NFT_FAMILY} ${NFT_TABLE}`,
    `table ${NFT_FAMILY} ${NFT_TABLE} {`,
    '  chain egress_mark {',
    '    type filter hook prerouting priority mangle; policy accept;',
    ...mark,
    '  }',
    '  chain egress_dns {',
    '    type nat hook prerouting priority dstnat - 5; policy accept;',
    ...dnat,
    '  }',
    '  chain egress_forward {',
    '    type filter hook forward priority filter - 5; policy accept;',
    ...forward,
    '  }',
    '  chain egress_input {',
    '    type filter hook input priority filter - 5; policy accept;',
    `    ${offMark} reject with icmpx admin-prohibited comment "offline"`,
    `    ${vpnMark} th dport 53 reject with icmpx port-unreachable comment "vpn dns without a tunnel"`,
    '  }',
    // the host's own lookups on behalf of VPN apps (Docker's resolver): marked, so routing sends them to the tunnel
    // (only with a tunnel: a marked packet that then finds no route is dropped silently inside the hook, and every
    // lookup waited out its timeouts; without one, egress_output refuses it at once)
    '  chain egress_route {',
    '    type route hook output priority mangle; policy accept;',
    ...(opts.tunnel ? [`    ip daddr ${VPN_DNS_ADDRESS} th dport 53 ${setMark(MARK_VPN)} comment "vpn apps' dns"`] : []),
    '  }',
    '  chain egress_dns_out {',
    '    type nat hook output priority dstnat - 5; policy accept;',
    ...(opts.dns ? [`    ip daddr ${VPN_DNS_ADDRESS} th dport 53 dnat ip to ${opts.dns}`] : []),
    '  }',
    '  chain egress_output {',
    '    type filter hook output priority filter - 5; policy accept;',
    `    ${vpnMark} oifname != "${TUNNEL_IF}" reject with icmpx admin-prohibited comment "kill switch"`,
    // not rewritten into the tunnel (no tunnel, or the table half-loaded): never sent anywhere
    `    ip daddr ${VPN_DNS_ADDRESS} reject with icmpx port-unreachable comment "vpn apps' dns without a tunnel"`,
    '  }',
    '  chain egress_nat {',
    '    type nat hook postrouting priority srcnat; policy accept;',
    `    oifname "${TUNNEL_IF}" masquerade`,
    '  }',
    '}',
    '',
  ].join('\n');
}

export function nftDeleteScript(): string {
  return `table ${NFT_FAMILY} ${NFT_TABLE} {}\ndelete table ${NFT_FAMILY} ${NFT_TABLE}\n`;
}

const MARK_ARG = `${hex(MARK_VPN)}/${hex(MARK_MASK)}`;

// `ip -4 rule add …` argument lists, in priority order. The DNS rule exists only with a tunnel DNS server.
export function ipRuleArgs(dns: string | null): string[][] {
  const rules: string[][] = [];
  if (dns) rules.push(['rule', 'add', 'priority', String(RULE_PRIORITY.dns), 'to', `${dns}/32`, 'fwmark', MARK_ARG, 'lookup', String(ROUTE_TABLE)]);
  rules.push(['rule', 'add', 'priority', String(RULE_PRIORITY.local), 'fwmark', MARK_ARG, 'lookup', 'main', 'suppress_prefixlength', '0']);
  rules.push(['rule', 'add', 'priority', String(RULE_PRIORITY.tunnel), 'fwmark', MARK_ARG, 'lookup', String(ROUTE_TABLE)]);
  return rules;
}

// Deleting by priority removes whatever Harbor added there, whatever its selector was.
export function ipRuleDeleteArgs(): string[][] {
  return Object.values(RULE_PRIORITY).map((p) => ['rule', 'del', 'priority', String(p)]);
}

// `ip rule show` lines Harbor owns (to know whether they need to be put back)
export function harborRulePriorities(ipRuleShow: string): number[] {
  const mine = new Set<number>(Object.values(RULE_PRIORITY));
  return ipRuleShow
    .split('\n')
    .map((l) => /^(\d+):/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .filter((p) => mine.has(p));
}

// The catch-all is always there; the tunnel route only while the interface exists. A lookup in table 4842
// therefore never falls through to the main table's default route. `unreachable`, not `blackhole`: a blackhole
// drops forwarded packets silently and every app waited out its own timeout (seen live); unreachable answers at
// once (ICMP), so an app without its VPN fails fast. Either way nothing leaves.
export function catchAllRouteArgs(): string[] {
  return ['route', 'replace', 'unreachable', 'default', 'table', String(ROUTE_TABLE), 'metric', '4294967295'];
}
export function tunnelRouteArgs(): string[] {
  return ['route', 'replace', 'default', 'dev', TUNNEL_IF, 'table', String(ROUTE_TABLE), 'metric', '0'];
}
export function flushRouteTableArgs(): string[] {
  return ['route', 'flush', 'table', String(ROUTE_TABLE)];
}

// The mode an app runs with (decision 184): the operator's choice, else the package's default, else direct;
// "every app through the VPN" turns direct into VPN and leaves offline alone. An app that requires the VPN
// (decision 208) never runs direct, whatever a stored choice says.
export function effectiveInternet(choice: InternetMode | null, packageDefault: InternetMode | null | undefined, allApps: boolean, requireVpn = false): InternetMode {
  const chosen = choice ?? packageDefault ?? 'direct';
  if (chosen === 'direct' && (allApps || requireVpn)) return 'vpn';
  return chosen;
}

export function isInternetMode(v: unknown): v is InternetMode {
  return v === 'direct' || v === 'vpn' || v === 'offline';
}

export function internetLabel(m: InternetMode): string {
  return m === 'direct' ? 'Direct' : m === 'vpn' ? 'Through the VPN' : 'Offline';
}
