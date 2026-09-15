import type { EndpointDto, PrimaryExposure } from '../contracts/api.js';
import type { EndpointAllocation, ExposureRow } from '../state/repo.js';
import { browserUrlFor } from '../config.js';

// The single place that turns allocations + exposures into the addresses users see.
export function exposureUrl(e: Pick<ExposureRow, 'via' | 'hostname' | 'port'>): string {
  if (e.via === 'public') return `https://${e.hostname}/`;
  return e.port === 443 ? `https://${e.hostname}/` : `https://${e.hostname}:${e.port}/`;
}

export function endpointUrls(alloc: EndpointAllocation, exposures: ExposureRow[], lanHost: string | null = null): EndpointDto['urls'] {
  const urls: EndpointDto['urls'] = { loopback: browserUrlFor(alloc.hostPort) };
  if (lanHost) urls.lan = `http://${lanHost}:${alloc.hostPort}/`;
  for (const e of exposures) {
    if (e.endpointId !== alloc.id) continue;
    if (e.via === 'tailnet') urls.tailnet = exposureUrl(e);
    if (e.via === 'public') urls.public = exposureUrl(e);
  }
  return urls;
}

// The URL handed to a package's `configuration` bindings: the instance's primary exposure, falling
// back to loopback when that exposure does not (yet) exist for the endpoint.
export function primaryUrlFor(alloc: EndpointAllocation, exposures: ExposureRow[], primary: PrimaryExposure): string {
  const urls = endpointUrls(alloc, exposures);
  if (primary === 'tailnet' && urls.tailnet) return urls.tailnet;
  if (primary === 'public' && urls.public) return urls.public;
  return urls.loopback;
}

export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
