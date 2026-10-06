// Decision 134: `remove` withdraws an app's addresses from Tailscale / Caddy but remembers them, and
// `reinstall` publishes them again (main address included). Kept in the settings table (one JSON doc,
// no migration) because a retained instance has no live exposure rows: a row means "served right now".
import type { ExposureVia, PrimaryExposure } from '../contracts/api.js';
import type { ExposureRow, Repo } from '../state/repo.js';

export const RETAINED_EXPOSURES_SETTING = 'exposures.retained';

export interface RetainedExposure {
  endpointId: string;
  via: ExposureVia;
  hostname: string;
  port: number;
  protection: 'none' | 'basic';
  proxyFrom: string | null;
}
export interface RetainedExposures {
  primary: PrimaryExposure;
  primaryHost: string | null;
  items: RetainedExposure[];
}

export function retainedExposures(repo: Repo, instanceId: string): RetainedExposures | null {
  return repo.setting<Record<string, RetainedExposures>>(RETAINED_EXPOSURES_SETTING)?.[instanceId] ?? null;
}

export function setRetainedExposures(repo: Repo, instanceId: string, value: RetainedExposures | null): void {
  const all = { ...(repo.setting<Record<string, RetainedExposures>>(RETAINED_EXPOSURES_SETTING) ?? {}) };
  if (value && value.items.length) all[instanceId] = value;
  else delete all[instanceId];
  repo.setSetting(RETAINED_EXPOSURES_SETTING, all);
}

export function toRetained(e: ExposureRow): RetainedExposure {
  return { endpointId: e.endpointId, via: e.via, hostname: e.hostname, port: e.port, protection: e.protection, proxyFrom: e.proxyFrom };
}

