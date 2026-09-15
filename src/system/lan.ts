import { hostname, networkInterfaces } from 'node:os';

// LAN mode: Harbor answers on the local network as http://<hostname>.local (mDNS via avahi) and on its
// addresses. The Host/Origin allow-list follows what this machine actually is, recomputed cheaply.
export function machineAddresses(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      out.add(a.address.toLowerCase());
    }
  }
  return [...out];
}

// RFC 1918 / link-local / CGNAT: "this looks like a home or office network, not the public internet".
export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
export function privateInterfaces(): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && a.family === 'IPv4' && isPrivateIPv4(a.address)) out.push({ name, address: a.address });
  }
  return out;
}

export function lanHostnames(): string[] {
  const h = hostname().toLowerCase().replace(/\.local$/, '');
  return [h, `${h}.local`, 'harbor.local'];
}

// Accept `Host:` values that name this machine on the LAN: <hostname>[.local], any *.local (avahi may suffix -2),
// or one of our own addresses, each with the LAN port, no port, or the management port.
export function lanHostAllowed(host: string, lanPort: number, managementPort: number, addresses: string[] = machineAddresses()): boolean {
  const m = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d+))?$/i.exec(host.trim());
  if (!m) return false;
  const name = m[1]!.toLowerCase().replace(/^\[|\]$/g, '');
  const port = m[2] ? Number(m[2]) : lanPort === 80 ? 80 : null;
  if (port !== null && port !== lanPort && port !== managementPort && !(port === 80 && lanPort === 80)) return false;
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1') return true;
  if (/^[a-z0-9-]+\.local$/.test(name)) return true;
  if (lanHostnames().includes(name)) return true;
  return addresses.includes(name);
}

export function lanUrl(port: number): string {
  const h = hostname().toLowerCase().replace(/\.local$/, '');
  return port === 80 ? `http://${h}.local/` : `http://${h}.local:${port}/`;
}
