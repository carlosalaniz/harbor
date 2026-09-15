import path from 'node:path';
import type { Ctx } from './context.js';
import type { ApplicationService } from './service.js';
import { instanceDir, loadReleaseSnapshot } from './instance-dir.js';
import { probeOnce } from './readiness.js';
import { LABELS } from '../naming.js';
import type { Readiness, Runtime } from '../state/repo.js';
import { exposureUrl } from '../exposure/urls.js';

// Periodic observation of what actually exists. Never mutates Docker.
export class Observer {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly service: ApplicationService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const ping = await this.ctx.docker.ping();
      this.service.recordDockerObservation({ available: ping.available, version: ping.version, error: ping.error });
      const now = this.ctx.repo.now();
      for (const inst of this.ctx.repo.listInstances()) {
        if (inst.activeOperationId) continue;
        if (!ping.available) {
          // Stale healthy becomes unknown when observation is unavailable.
          this.ctx.repo.updateInstance(inst.id, { runtime: 'unavailable', readiness: 'unknown', observedAt: now });
          continue;
        }
        if (inst.installState === 'retained') {
          this.ctx.repo.updateInstance(inst.id, { runtime: 'stopped', readiness: 'unknown', observedAt: now });
          continue;
        }
        const containers = this.ctx.repo.resources(inst.id).filter((r) => r.kind === 'container');
        let running = 0;
        let present = 0;
        for (const r of containers) {
          try {
            const c = await this.ctx.docker.inspectContainer(r.dockerId ?? r.name);
            if (c && c.labels[LABELS.instance] === inst.id) {
              present += 1;
              if (c.state === 'running') running += 1;
            }
          } catch {
            /* treat as absent */
          }
        }
        let runtime: Runtime;
        if (!containers.length || present === 0) runtime = 'unknown';
        else if (running === present) runtime = 'running';
        else if (running === 0) runtime = 'stopped';
        else runtime = 'starting';
        let readiness: Readiness = 'unknown';
        if (runtime === 'running' && inst.installState === 'installed') {
          readiness = (await this.quickProbe(inst.id, inst.packageId, inst.endpoints)) ? 'healthy' : 'unhealthy';
        }
        this.ctx.repo.updateInstance(inst.id, { runtime, readiness, observedAt: now });
      }
      await this.verifyExposures(now);
    } catch (e) {
      this.ctx.log.warn(`observer tick failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  // Published addresses are re-checked every tick; a degraded exposure recovers when DNS/certificates settle.
  // Tailnet addresses are also re-applied: a `tailscale logout`/login cycle drops the serve entries (and may
  // rename the node), so the recorded exposures are put back as soon as the node is Running again.
  private async verifyExposures(now: string): Promise<void> {
    await this.reconcileTailnet();
    for (const e of this.ctx.repo.exposures()) {
      if (e.state === 'removing') continue;
      const inst = this.ctx.repo.instance(e.instanceId);
      if (!inst || inst.activeOperationId) continue;
      const r = await this.ctx.verify(exposureUrl(e));
      const state = r.ok ? 'active' : 'degraded';
      if (state !== e.state || r.ok) this.ctx.repo.updateExposure(e.id, { state, observedAt: now, note: r.ok ? `answered HTTP ${r.status}` : `not reachable: ${r.error ?? `HTTP ${r.status}`}` });
      else this.ctx.repo.updateExposure(e.id, { observedAt: now });
    }
  }

  private async reconcileTailnet(): Promise<void> {
    const tailnet = this.ctx.repo.exposures().filter((e) => e.via === 'tailnet' && e.state !== 'removing');
    if (!tailnet.length) return;
    let st;
    try {
      st = await this.ctx.tailscale.status();
    } catch {
      return;
    }
    if (!st || st.backendState !== 'Running' || !st.dnsName) return;
    let entries;
    try {
      entries = await this.ctx.tailscale.serveEntries();
    } catch {
      return;
    }
    for (const e of tailnet) {
      const target = `http://127.0.0.1:${e.port}`;
      const fixes: string[] = [];
      if (!entries.some((x) => x.port === e.port && x.target === target)) {
        try {
          await this.ctx.tailscale.serve(e.port, target);
          fixes.push('serve entry re-applied');
        } catch (err) {
          this.ctx.log.warn(`could not re-apply tailnet serve for port ${e.port}: ${(err as Error).message}`);
          continue;
        }
      }
      if (e.hostname !== st.dnsName) {
        this.ctx.repo.updateExposureHostname(e.id, st.dnsName);
        fixes.push(`node name ${e.hostname} -> ${st.dnsName}`);
      }
      if (fixes.length) {
        this.ctx.repo.addEvent({ instanceId: e.instanceId, phase: 'observer', message: `tailnet address restored after Tailscale reconnected (${fixes.join('; ')})` });
        this.ctx.log.info('tailnet exposure reconciled', { instanceId: e.instanceId, port: e.port, fixes });
      }
    }
  }

  private async quickProbe(instanceId: string, packageId: string, endpoints: { id: string; hostPort: number }[]): Promise<boolean> {
    try {
      const pkg = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, instanceId), 'release'), packageId);
      const alloc = endpoints.find((e) => e.id === pkg.manifest.health.endpoint);
      if (!alloc) return false;
      const r = await probeOnce(alloc.hostPort, pkg.manifest.health.path, pkg.manifest.health.expectedStatus, pkg.manifest.health.timeoutSeconds * 1000);
      return r.ok;
    } catch {
      return false;
    }
  }
}
