// mDNS (avahi) hygiene for LAN mode: Harbor prints `http://<hostname>.local`
// at install, so it owns making that name resolve — and it is also the thing
// that breaks it. avahi publishes the host name on EVERY interface that is
// up, and Harbor creates Docker bridges (docker0, one br-* per app). With an
// app running, `harbor.local` gets answered with 172.17.0.1 / 172.18.0.1 next
// to the real LAN address, and clients (macOS in particular) end up with an
// unroutable address or no answer at all. Seen live on carlos-desktop
// (decision 107): `avahi-resolve -n harbor.local` returned 172.17.0.1.
//
// Fix: publish only on the interface(s) carrying the IPv4 default route, via
// `allow-interfaces=` in /etc/avahi/avahi-daemon.conf, re-evaluated on every
// bootstrap so a move from Wi-Fi to Ethernet is picked up by a re-run.
//
// Second live lesson: `systemctl restart avahi-daemon` (the service alone,
// with avahi-daemon.socket left running) can leave avahi in a state where it
// answers legacy unicast queries (dig) but not standard mDNS queries from
// port 5353 — the name is "published" yet no client resolves it. Always
// restart socket AND service together.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { exec, execOk } from './exec.js';

export const AVAHI_CONF = '/etc/avahi/avahi-daemon.conf';

// `ip -o -4 route show default` → the interface name after `dev`, per line,
// in order, unique. Empty when there is no default route (offline box).
export function defaultRouteInterfaces(ipRouteOutput: string): string[] {
  const out: string[] = [];
  for (const line of ipRouteOutput.split('\n')) {
    const m = /\bdev\s+([A-Za-z0-9_.:-]+)/.exec(line);
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

// Set `allow-interfaces=<ifaces>` in the [server] section: replace an existing
// (or commented) line, insert one after the header, or create the section.
// Idempotent. An empty interface list returns the text unchanged — an empty
// allow-list would silence avahi entirely, which is worse than the bridges.
export function avahiConfWithAllowInterfaces(conf: string, ifaces: string[]): string {
  if (ifaces.length === 0) return conf;
  const wanted = `allow-interfaces=${ifaces.join(',')}`;
  const lines = conf.split('\n');
  const serverIdx = lines.findIndex((l) => /^\s*\[server\]\s*$/.test(l));
  if (serverIdx === -1) {
    return `[server]\n${wanted}\n\n${conf.replace(/^\n+/, '')}`;
  }
  // The [server] section runs until the next [section] header.
  let end = lines.length;
  for (let i = serverIdx + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  for (let i = serverIdx + 1; i < end; i++) {
    if (/^\s*#?\s*allow-interfaces\s*=/.test(lines[i]!)) {
      if (lines[i] === wanted) return conf;
      lines[i] = wanted;
      return lines.join('\n');
    }
  }
  lines.splice(serverIdx + 1, 0, wanted);
  return lines.join('\n');
}

// Root step (bootstrap, LAN mode): pin avahi to the default-route
// interface(s) and restart it properly. Never throws: mDNS is a convenience,
// and the daemon must come up regardless.
export async function configureAvahiForLan(log: (m: string) => void): Promise<{ interfaces: string[]; changed: boolean }> {
  let interfaces: string[] = [];
  try {
    const r = await exec('/usr/sbin/ip', ['-o', '-4', 'route', 'show', 'default'], { timeoutMs: 10_000 });
    interfaces = defaultRouteInterfaces(r.stdout);
  } catch (e) {
    log(`mDNS: could not read the default route (${e instanceof Error ? e.message : String(e)}); leaving avahi on all interfaces`);
    return { interfaces, changed: false };
  }
  if (interfaces.length === 0) {
    log('mDNS: no IPv4 default route right now; leaving avahi on all interfaces');
    return { interfaces, changed: false };
  }
  let changed = false;
  if (existsSync(AVAHI_CONF)) {
    try {
      const before = readFileSync(AVAHI_CONF, 'utf8');
      const after = avahiConfWithAllowInterfaces(before, interfaces);
      if (after !== before) {
        writeFileSync(AVAHI_CONF, after, { mode: 0o644 });
        changed = true;
        log(`mDNS: avahi publishes ${'<hostname>.local'} only on ${interfaces.join(', ')} (not on Docker bridges)`);
      }
    } catch (e) {
      log(`mDNS: could not update ${AVAHI_CONF} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  try {
    // Socket AND service, always: a service-only restart can leave avahi
    // answering legacy unicast queries but not standard mDNS ones.
    await execOk('/usr/bin/systemctl', ['enable', 'avahi-daemon.socket', 'avahi-daemon.service'], { timeoutMs: 60_000 });
    await execOk('/usr/bin/systemctl', ['restart', 'avahi-daemon.socket', 'avahi-daemon.service'], { timeoutMs: 60_000 });
  } catch (e) {
    log(`mDNS: avahi restart failed (${e instanceof Error ? e.message : String(e)}); run: sudo systemctl restart avahi-daemon.socket avahi-daemon.service`);
  }
  return { interfaces, changed };
}
