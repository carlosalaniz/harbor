import path from 'node:path';
import type { Ctx } from './context.js';
import type { ApplicationService } from './service.js';
import { instanceDir, loadReleaseSnapshot } from './instance-dir.js';
import { probeOnce } from './readiness.js';
import { LABELS } from '../naming.js';
import type { Readiness, Runtime } from '../state/repo.js';

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
    } catch (e) {
      this.ctx.log.warn(`observer tick failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
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
