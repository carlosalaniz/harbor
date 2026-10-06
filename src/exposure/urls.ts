import type { EndpointDto, PrimaryExposure } from '../contracts/api.js';
import type { EndpointAllocation, ExposureRow } from '../state/repo.js';
import { browserUrlFor } from '../config.js';
import { lanHttpsUrl } from '../system/lan-https.js';

// The single place that turns allocations + exposures into the addresses users see.
export function exposureUrl(e: Pick<ExposureRow, 'via' | 'hostname' | 'port'>): string {
  if (e.via === 'public' || e.via === 'proxy') return `https://${e.hostname}/`;
  return e.port === 443 ? `https://${e.hostname}/` : `https://${e.hostname}:${e.port}/`;
}

// Decision 127: an endpoint may carry several public hostnames. The main one is the instance's
// `primaryHost` when it is still published there, else the first one published (exposures come
// ordered by publication). Returns null when the endpoint has no public hostname.
export function mainPublicExposure<T extends Pick<ExposureRow, 'via' | 'endpointId' | 'hostname'>>(exposures: T[], endpointId: string, primaryHost: string | null): T | null {
  const pub = exposures.filter((e) => e.via === 'public' && e.endpointId === endpointId);
  return pub.find((e) => e.hostname === primaryHost) ?? pub[0] ?? null;
}

export function endpointUrls(alloc: EndpointAllocation, exposures: ExposureRow[], lanHost: string | null = null, lanSecure: { host: string } | null = null, primaryHost: string | null = null): EndpointDto['urls'] {
  const urls: EndpointDto['urls'] = { loopback: browserUrlFor(alloc.hostPort) };
  if (lanHost) urls.lan = `http://${lanHost}:${alloc.hostPort}/`;
  if (lanSecure) {
    try {
      urls.lanSecure = lanHttpsUrl(lanSecure.host, alloc.hostPort);
    } catch {
      /* offset overflow: no secure address for this endpoint */
    }
  }
  for (const e of exposures) {
    if (e.endpointId !== alloc.id) continue;
    if (e.via === 'tailnet') urls.tailnet = exposureUrl(e);
    if (e.via === 'proxy') urls.proxy = exposureUrl(e);
  }
  const main = mainPublicExposure(exposures, alloc.id, primaryHost);
  if (main) urls.public = exposureUrl(main);
  return urls;
}

// The URL handed to a package's `configuration` bindings and hooks (the app's main address): the
// instance's primary exposure; `loopback` means "this network" — the secure LAN address when LAN HTTPS
// is on (decision 116), else the LAN address in LAN mode (decision 115: a LAN browser cannot reach
// `localhost`), else loopback. A missing tailnet/public exposure falls back the same way. With several
// public hostnames, `primaryHost` picks the main one (decision 127).
export function primaryUrlFor(alloc: EndpointAllocation, exposures: ExposureRow[], primary: PrimaryExposure, lanHost: string | null = null, lanSecureHost: string | null = null, primaryHost: string | null = null): string {
  const urls = endpointUrls(alloc, exposures, lanHost, lanSecureHost ? { host: lanSecureHost } : null, primaryHost);
  if (primary === 'tailnet' && urls.tailnet) return urls.tailnet;
  if (primary === 'public' && urls.public) return urls.public;
  return urls.lanSecure ?? urls.lan ?? urls.loopback;
}

// Every `host[:port]` an app answers on right now (decision 116), for packages whose app checks the
// Host it is reached by (Nextcloud's trusted_domains): loopback, the LAN names and addresses on the
// plain and (when on) secure ports, and each tailnet/public/proxy exposure (every public hostname,
// decision 127). Sorted, no duplicates.
export function appAuthorities(allocs: EndpointAllocation[], exposures: ExposureRow[], lan: { names: string[]; secure: boolean } | null): string[] {
  const out = new Set<string>();
  for (const a of allocs) {
    out.add(`localhost:${a.hostPort}`);
    out.add(`127.0.0.1:${a.hostPort}`);
    for (const name of lan?.names ?? []) {
      out.add(`${name}:${a.hostPort}`);
      if (lan?.secure) {
        try {
          out.add(new URL(lanHttpsUrl(name, a.hostPort)).host);
        } catch {
          /* offset overflow: no secure address for this endpoint */
        }
      }
    }
    for (const e of exposures) if (e.endpointId === a.id) out.add(new URL(exposureUrl(e)).host);
  }
  return [...out].sort();
}

export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
