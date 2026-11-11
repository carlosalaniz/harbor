// Decision 200: which app endpoints Harbor announces on the LAN with DNS-SD, and the avahi-publish arguments for
// each. PURE: the service hands in what it read (LAN mode, LAN HTTPS, each app's state and runtime binding).
//
// Rule: announce only an address that works from the LAN. A plain port on 0.0.0.0 (`lan`) is announced as http,
// with its secure twin as `secure-port` when LAN HTTPS is on; an app behind the HTTPS-only relay (`relay`) is
// announced at its secure twin as https; an app bound to loopback is not announced at all.
import type { ManifestAdvertise } from '../contracts/types.js';

// TXT keys Harbor sets on every announcement (a package may not set them itself)
export const ADVERTISE_RESERVED_TXT = ['app', 'harbor', 'scheme', 'secure-port'];
export const DNS_LABEL_BYTES = 63;

export type AdvertLanAccess = 'lan' | 'relay' | 'loopback';

export interface AdvertSource {
  instanceId: string;
  packageId: string;
  appName: string; // the name the operator sees (display name, else the instance name)
  running: boolean; // installed, wanted running and observed running
  access: AdvertLanAccess | null; // how the running containers are bound (null = never rendered)
  endpoints: { id: string; hostPort: number; advertise: ManifestAdvertise }[];
}

export interface AdvertContext {
  lan: boolean; // LAN mode
  https: boolean; // LAN HTTPS (secure twins exist)
  securePort: (hostPort: number) => number | null; // the twin of a plain port (null = none)
}

export interface Advert {
  key: string; // <instanceId>/<endpointId>
  instanceId: string;
  endpointId: string;
  name: string;
  type: string;
  port: number;
  txt: [string, string][];
}

export type AdvertOffReason = 'lan-off' | 'not-running' | 'loopback';
export interface AdvertOff {
  key: string;
  instanceId: string;
  endpointId: string;
  name: string;
  type: string;
  reason: AdvertOffReason;
}

export const OFF_REASON_TEXT: Record<AdvertOffReason, string> = {
  'lan-off': 'LAN mode is off',
  'not-running': 'the app is not running',
  loopback: 'the app is only reachable on this machine until it restarts',
};

// Cut a string to at most `max` UTF-8 bytes without splitting a character.
export function truncateBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > max) break;
    out += ch;
  }
  return out;
}

// avahi refuses a second local service with the same name and type ("Local name collision") instead of
// renaming it, so names are made unique here: the first keeps its name, the next get " #2", " #3"…
// (DNS compares names without case).
function uniqueName(base: string, taken: Set<string>): string {
  const first = truncateBytes(base, DNS_LABEL_BYTES);
  if (!taken.has(first.toLowerCase())) return first;
  for (let n = 2; ; n += 1) {
    const suffix = ` #${n}`;
    const name = truncateBytes(base, DNS_LABEL_BYTES - Buffer.byteLength(suffix)) + suffix;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function planAdverts(ctx: AdvertContext, sources: AdvertSource[]): { adverts: Advert[]; off: AdvertOff[] } {
  const adverts: Advert[] = [];
  const off: AdvertOff[] = [];
  const takenByType = new Map<string, Set<string>>();
  const ordered = [...sources].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  for (const src of ordered) {
    const eps = [...src.endpoints].sort((a, b) => a.id.localeCompare(b.id));
    for (const ep of eps) {
      const key = `${src.instanceId}/${ep.id}`;
      const ad = ep.advertise;
      const base = (ad.name ?? src.appName).trim() || src.packageId;
      const reason: AdvertOffReason | null = !ctx.lan ? 'lan-off' : !src.running ? 'not-running' : src.access === 'lan' || src.access === 'relay' ? null : 'loopback';
      let port: number | null = null;
      let secure: number | null = null;
      if (!reason) {
        secure = ctx.https ? ctx.securePort(ep.hostPort) : null;
        port = src.access === 'lan' ? ep.hostPort : secure;
      }
      if (reason || port === null) {
        off.push({ key, instanceId: src.instanceId, endpointId: ep.id, name: truncateBytes(base, DNS_LABEL_BYTES), type: ad.type, reason: reason ?? 'loopback' });
        continue;
      }
      const taken = takenByType.get(ad.type) ?? new Set<string>();
      takenByType.set(ad.type, taken);
      const name = uniqueName(base, taken);
      taken.add(name.toLowerCase());
      const txt: [string, string][] = Object.entries(ad.txt ?? {})
        .filter(([k]) => !ADVERTISE_RESERVED_TXT.includes(k))
        .sort(([a], [b]) => a.localeCompare(b));
      txt.push(['app', src.packageId], ['harbor', '1'], ['scheme', src.access === 'lan' ? 'http' : 'https']);
      if (src.access === 'lan' && secure !== null) txt.push(['secure-port', String(secure)]);
      adverts.push({ key, instanceId: src.instanceId, endpointId: ep.id, name, type: ad.type, port, txt });
    }
  }
  return { adverts, off };
}

// `--` ends avahi-publish's options, so a name or TXT entry that starts with "-" stays an argument (checked live).
// -f: keep running and publish again when avahi restarts (bootstrap restarts it, decision 107).
export function publishArgs(a: Advert): string[] {
  return ['-s', '-f', '--', a.name, a.type, String(a.port), ...a.txt.map(([k, v]) => `${k}=${v}`)];
}
