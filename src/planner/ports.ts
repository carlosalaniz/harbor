import type { Manifest } from '../contracts/types.js';
import type { EndpointAllocation } from '../state/repo.js';
import { HarborError } from '../errors.js';

export interface PortRange {
  from: number;
  to: number;
}

// Pure allocation: lowest eligible port per endpoint, endpoints sorted by ID for stable rendering.
// `unavailable` already merges stored claims, queued claims, Docker bindings and observed listeners.
export function allocateEndpoints(manifest: Manifest, range: PortRange, unavailable: Set<number>): EndpointAllocation[] {
  const used = new Set(unavailable);
  const out: EndpointAllocation[] = [];
  for (const id of Object.keys(manifest.endpoints).sort()) {
    const ep = manifest.endpoints[id]!;
    let chosen: number | null = null;
    for (let p = range.from; p <= range.to; p++) {
      if (!used.has(p)) {
        chosen = p;
        break;
      }
    }
    if (chosen === null) {
      throw new HarborError('PORT_CONFLICT', `no free loopback port in ${range.from}-${range.to} for endpoint ${id}`, {
        nextAction: 'Free a port in the configured range or remove retained instances that hold allocations.',
      });
    }
    used.add(chosen);
    out.push({ id, service: ep.service, containerPort: ep.containerPort, hostPort: chosen });
  }
  return out;
}
