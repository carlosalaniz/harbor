// Decision 191: Harbor gives every network it makes (an app's own network, each link network) a /24 from its own
// block instead of letting Docker pick from its default pools. Those pools hold about 30 networks (fifteen /16s in
// 172.17–31, sixteen /20s in 192.168, minus any the home network overlaps), and a box that once ran other Compose
// stacks fills them with empty leftovers: every later install then failed with Docker's "all predefined address
// pools have been fully subnetted". Harbor's block holds 2048 networks and skips anything already in use: other
// Docker networks and every address range this machine routes (its LAN, a VPN, Tailscale).
//
// A network that already exists keeps the subnet it has (the Compose file only names a subnet Harbor chose), so an
// upgrade never touches a running app.

export const HARBOR_SUBNET_BLOCK = '10.200.0.0/13';
export const HARBOR_SUBNET_PREFIX = 24;

interface Cidr {
  base: number; // network address, host bits cleared
  prefix: number;
}

function parseV4(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

function mask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

// IPv4 CIDRs only ("10.200.3.0/24", or a bare address as a /32); anything else (IPv6, garbage) is null.
function parseCidr(v: string): Cidr | null {
  const [addr, len, extra] = v.trim().split('/');
  if (extra !== undefined || addr === undefined) return null;
  const ip = parseV4(addr);
  const prefix = len === undefined ? 32 : /^\d{1,2}$/.test(len) ? Number(len) : NaN;
  if (ip === null || !(prefix >= 0 && prefix <= 32)) return null;
  return { base: (ip & mask(prefix)) >>> 0, prefix };
}

function format(n: number, prefix: number): string {
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}/${prefix}`;
}

export function subnetsOverlap(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  if (!x || !y) return false;
  const p = Math.min(x.prefix, y.prefix);
  return ((x.base & mask(p)) >>> 0) === ((y.base & mask(p)) >>> 0);
}

// A subnet Harbor handed out: a /24 inside its block.
export function isHarborSubnet(v: string): boolean {
  const c = parseCidr(v);
  return c !== null && c.prefix === HARBOR_SUBNET_PREFIX && v.includes('/') && subnetsOverlap(v, HARBOR_SUBNET_BLOCK);
}

// The first /24 of Harbor's block that overlaps nothing in `taken` (Docker networks' subnets, this machine's
// routes and interface ranges). A default route (0.0.0.0/0) means "everything else", not a range in use, and is
// ignored. null = the block is full.
export function pickSubnet(taken: readonly string[]): string | null {
  const block = parseCidr(HARBOR_SUBNET_BLOCK)!;
  const used = taken.map(parseCidr).filter((c): c is Cidr => c !== null && c.prefix > 0);
  const step = 2 ** (32 - HARBOR_SUBNET_PREFIX);
  const count = 2 ** (HARBOR_SUBNET_PREFIX - block.prefix);
  for (let i = 0; i < count; i++) {
    const candidate = format(block.base + i * step, HARBOR_SUBNET_PREFIX);
    if (!used.some((u) => subnetsOverlap(candidate, format(u.base, u.prefix)))) return candidate;
  }
  return null;
}

// /proc/net/route → the IPv4 ranges this machine routes (destination + mask are little-endian hex). The default
// route is left out (see pickSubnet).
export function routesFromProcNetRoute(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || !/^[0-9A-Fa-f]{8}$/.test(f[1]!) || !/^[0-9A-Fa-f]{8}$/.test(f[7]!)) continue;
    const le = (h: string) => (parseInt(h.slice(6, 8) + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2), 16) >>> 0);
    const dest = le(f[1]!);
    const m = le(f[7]!);
    if (m === 0) continue;
    const prefix = Math.clz32(~m >>> 0); // contiguous mask: its leading ones
    out.push(format((dest & mask(prefix)) >>> 0, prefix));
  }
  return [...new Set(out)];
}
