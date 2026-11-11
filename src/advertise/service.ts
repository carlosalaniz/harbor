// Decision 200: LAN announcements, daemon side. The wanted set is computed fresh from every app each time
// (LAN mode, LAN HTTPS, the app's state and how its running containers are bound) and handed to the publisher,
// which only starts and stops what changed. Called after every operation and on every observer tick.
import path from 'node:path';
import type { Ctx } from '../lifecycle/context.js';
import type { InstanceRow } from '../state/repo.js';
import type { ManifestAdvertise } from '../contracts/types.js';
import type { AnnounceDto } from '../contracts/api.js';
import { instanceDir, loadReleaseSnapshot } from '../lifecycle/instance-dir.js';
import { HTTPS_SETTING, lanHttpsPort, runtimeLanAccess } from '../system/lan-https.js';
import { OFF_REASON_TEXT, planAdverts, type AdvertOff, type AdvertSource } from './adverts.js';
import type { AdvertPublisher } from './publisher.js';

export class AdvertiseService {
  // what each installed revision asks to announce, by `<instanceId>@<revision>`
  private readonly declared = new Map<string, Record<string, ManifestAdvertise>>();
  private off = new Map<string, AdvertOff>();
  private unavailableLogged = false;

  constructor(
    private readonly ctx: Pick<Ctx, 'config' | 'repo' | 'log'>,
    readonly publisher: AdvertPublisher,
  ) {}

  private advertised(inst: InstanceRow): Record<string, ManifestAdvertise> {
    const key = `${inst.id}@${inst.revision}`;
    const hit = this.declared.get(key);
    if (hit) return hit;
    const out: Record<string, ManifestAdvertise> = {};
    try {
      const { manifest } = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'release'), inst.packageId);
      for (const [id, ep] of Object.entries(manifest.endpoints)) if (ep.advertise) out[id] = ep.advertise;
    } catch {
      return out; // no readable release: nothing to announce (and the app cannot run either); not cached
    }
    this.declared.set(key, out);
    return out;
  }

  private sources(): AdvertSource[] {
    const out: AdvertSource[] = [];
    for (const inst of this.ctx.repo.listInstances()) {
      if (inst.purgedAt || inst.installState === 'retained') continue;
      const declared = this.advertised(inst);
      const endpoints = inst.endpoints.filter((e) => declared[e.id]).map((e) => ({ id: e.id, hostPort: e.hostPort, advertise: declared[e.id]! }));
      if (!endpoints.length) continue;
      out.push({
        instanceId: inst.id,
        packageId: inst.packageId,
        appName: inst.displayName ?? inst.name,
        running: inst.installState === 'installed' && inst.desired === 'running' && inst.runtime === 'running',
        access: runtimeLanAccess(this.ctx.config.stateDir, inst.id),
        endpoints,
      });
    }
    return out;
  }

  sync(): void {
    try {
      const lan = this.ctx.config.lan.enabled;
      const plan = planAdverts(
        {
          lan,
          https: lan && (this.ctx.repo.setting<boolean>(HTTPS_SETTING) ?? false),
          securePort: (p) => {
            try {
              return lanHttpsPort(p);
            } catch {
              return null;
            }
          },
        },
        this.sources(),
      );
      this.off = new Map(plan.off.map((o) => [o.key, o]));
      if (plan.adverts.length && !this.publisher.available()) {
        if (!this.unavailableLogged) this.ctx.log.warn('apps ask to be announced on the network, but avahi-publish is not installed (run the Harbor installer again in LAN mode)');
        this.unavailableLogged = true;
        return;
      }
      this.publisher.apply(plan.adverts);
    } catch (e) {
      this.ctx.log.warn(`announcing apps on the network failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // The app page's line per announced endpoint.
  statusFor(inst: InstanceRow): AnnounceDto[] {
    const declared = this.advertised(inst);
    const out: AnnounceDto[] = [];
    for (const ep of inst.endpoints) {
      const ad = declared[ep.id];
      if (!ad) continue;
      const key = `${inst.id}/${ep.id}`;
      const off = this.off.get(key);
      if (off) {
        out.push({ endpointId: ep.id, type: ad.type, name: off.name, state: 'off', reason: OFF_REASON_TEXT[off.reason] });
        continue;
      }
      const s = this.publisher.state(key);
      if (s?.state === 'announced') out.push({ endpointId: ep.id, type: ad.type, name: s.name ?? ad.name ?? inst.displayName ?? inst.name, state: 'announced' });
      else if (s?.state === 'failed') out.push({ endpointId: ep.id, type: ad.type, name: ad.name ?? inst.displayName ?? inst.name, state: 'failed', reason: s.error ?? 'avahi refused it' });
      else if (!this.publisher.available()) out.push({ endpointId: ep.id, type: ad.type, name: ad.name ?? inst.displayName ?? inst.name, state: 'failed', reason: 'avahi-publish is not installed' });
      else out.push({ endpointId: ep.id, type: ad.type, name: ad.name ?? inst.displayName ?? inst.name, state: 'starting' });
    }
    return out;
  }

  close(): Promise<void> {
    return this.publisher.close();
  }
}
