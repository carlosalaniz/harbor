import path from 'node:path';
import type { Ctx } from './context.js';
import type { ApplicationService } from './service.js';
import { instanceDir, loadReleaseSnapshot } from './instance-dir.js';
import { probeOnce } from './readiness.js';
import { LABELS } from '../naming.js';
import type { Readiness, Runtime } from '../state/repo.js';
import { exposureUrl } from '../exposure/urls.js';
import { renderCaddyConfig } from '../exposure/caddy.js';
import { caddyLanConsole, caddyRoutesFromState, caddySignature } from './runner.js';
import { compareRevisions } from '../packages/store.js';
import { sampleDisk } from '../system/metrics.js';

// Periodic observation of what actually exists. Never mutates Docker.
export class Observer {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private caddyApplied: string | null = null;
  private lastSourceCheck = 0;

  constructor(
    private readonly ctx: Ctx,
    private readonly service: ApplicationService,
    private readonly intervalMs: number,
    // git sources are polled on their own, much slower cadence (decision 80; default 15 min)
    private readonly sourceCheckMs: number = 15 * 60_000,
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
        let cpuPercent = 0;
        let memoryBytes = 0;
        let sampled = 0;
        for (const r of containers) {
          try {
            const c = await this.ctx.docker.inspectContainer(r.dockerId ?? r.name);
            if (c && c.labels[LABELS.instance] === inst.id) {
              present += 1;
              if (c.state === 'running') {
                running += 1;
                try {
                  const s = await this.ctx.docker.containerStats(c.id);
                  if (s) {
                    cpuPercent += s.cpuPercent;
                    memoryBytes += s.memoryBytes;
                    sampled += 1;
                  }
                } catch {
                  /* stats are best-effort */
                }
              }
            }
          } catch {
            /* treat as absent */
          }
        }
        this.service.recordUsage(inst.id, sampled > 0 ? { cpuPercent: Math.round(cpuPercent * 10) / 10, memoryBytes } : null);
        let runtime: Runtime;
        if (!containers.length || present === 0) runtime = 'unknown';
        else if (running === present) runtime = 'running';
        else if (running === 0) runtime = 'stopped';
        else runtime = 'starting';
        let readiness: Readiness = 'unknown';
        if (runtime === 'running' && inst.installState === 'installed') {
          readiness = (await this.quickProbe(inst.id, inst.packageId, inst.endpoints)) ? 'healthy' : 'unhealthy';
        }
        // An app that should be running but is not answering is a warning; recovery clears the unread row.
        if (inst.desired === 'running' && inst.installState === 'installed' && (readiness === 'unhealthy' || runtime === 'stopped')) {
          this.ctx.notifier.notify({ kind: 'app-degraded', severity: 'warning', title: `${inst.displayName ?? inst.name} is not answering`, body: runtime === 'stopped' ? 'Its containers are not running. Open the app drawer to start it or check its logs.' : 'Its containers run but the app does not answer its health check. Check its logs under Troubleshoot.', instanceId: inst.id, dedupeKey: `app-degraded:${inst.id}` });
        } else this.ctx.notifier.resolve(`app-degraded:${inst.id}`);
        this.ctx.repo.updateInstance(inst.id, { runtime, readiness, observedAt: now });
      }
      this.notifyUpdatesAndDisk();
      if (Date.now() - this.lastSourceCheck >= this.sourceCheckMs) {
        this.lastSourceCheck = Date.now();
        await this.service.checkAllSources();
      }
      await this.service.runAutoUpdates();
      await this.verifyExposures(now);
    } catch (e) {
      this.ctx.log.warn(`observer tick failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  // Update-available and disk-pressure notifications ride the same tick (cheap reads, dedupe upserts).
  private notifyUpdatesAndDisk(): void {
    try {
      const current = this.ctx.packages.currentRevisions();
      for (const i of this.ctx.repo.listInstances()) {
        if (i.purgedAt || i.installState !== 'installed') continue;
        const cur = current.get(i.packageId);
        const key = cur ? `update:${i.id}:${cur.revision}` : null;
        if (key && compareRevisions(cur!.revision, i.revision) > 0) {
          this.ctx.notifier.notify({ kind: 'update-available', severity: 'info', title: `Update for ${i.displayName ?? i.name}`, body: `Revision ${i.revision} → ${cur!.revision}${cur!.version ? ` (${cur!.version})` : ''}. Update from the app drawer or Home; your data stays.`, instanceId: i.id, dedupeKey: key });
        } else if (key) this.ctx.notifier.resolve(key);
      }
    } catch {
      /* package store trouble is reported elsewhere */
    }
    try {
      const disk = sampleDisk();
      if (disk && disk.totalBytes > 0) {
        const pct = Math.round((disk.usedBytes / disk.totalBytes) * 100);
        if (pct >= 90) this.ctx.notifier.notify({ kind: 'disk-pressure', severity: pct >= 95 ? 'error' : 'warning', title: `Disk ${pct}% full`, body: 'Apps can fail when the disk fills up. Remove unused apps or data, or check Settings → Storage.', dedupeKey: 'disk-pressure' });
        else this.ctx.notifier.resolve('disk-pressure');
      }
    } catch {
      /* statfs unavailable on this platform */
    }
    // Harbor's own update (manual by design, decision 70): notify only.
    const su = this.ctx.selfUpdate.status();
    if (su.available && su.latest) {
      this.ctx.notifier.notify({ kind: 'harbor-update', severity: 'info', title: `Harbor ${su.latest.version} is available`, body: 'Update from Settings → Overview. Apps keep running; the console is briefly unavailable.', dedupeKey: `harbor-update:${su.latest.version}` });
    }
  }

  // Published addresses are re-checked every tick; a degraded exposure recovers when DNS/certificates settle.
  // Tailnet addresses are also re-applied: a `tailscale logout`/login cycle drops the serve entries (and may
  // rename the node), so the recorded exposures are put back as soon as the node is Running again.
  private async verifyExposures(now: string): Promise<void> {
    await this.reconcileTailnet();
    await this.reconcileCaddy();
    for (const e of this.ctx.repo.exposures()) {
      if (e.state === 'removing') continue;
      const inst = this.ctx.repo.instance(e.instanceId);
      if (!inst || inst.activeOperationId) continue;
      const r = await this.ctx.verify(exposureUrl(e));
      const state = r.ok ? 'active' : 'degraded';
      if (state === 'degraded') this.ctx.notifier.notify({ kind: 'exposure-degraded', severity: 'warning', title: `${inst.name} is not reachable at ${e.hostname}`, body: `${exposureUrl(e)} does not answer: ${r.error ?? `HTTP ${r.status}`}. Harbor keeps checking and recovers the address automatically when DNS/certificates settle.`, instanceId: e.instanceId, dedupeKey: `exposure-degraded:${e.id}` });
      else this.ctx.notifier.resolve(`exposure-degraded:${e.id}`);
      if (state !== e.state || r.ok) this.ctx.repo.updateExposure(e.id, { state, observedAt: now, note: r.ok ? `answered HTTP ${r.status}` : `not reachable: ${r.error ?? `HTTP ${r.status}`}` });
      else this.ctx.repo.updateExposure(e.id, { observedAt: now });
    }
  }

  // Caddy runs with whatever config it resumed with (the package's stock file server on a fresh machine, or an
  // older Harbor state). Put the desired config in place at startup and whenever the desired state changes.
  private async reconcileCaddy(): Promise<void> {
    const want = caddySignature(this.ctx);
    if (want === this.caddyApplied) return;
    const publicRoutes = this.ctx.repo.exposures().some((e) => e.via === 'public');
    if (!publicRoutes && !this.ctx.config.lan.enabled) {
      this.caddyApplied = want; // nothing to manage; leave Caddy alone
      return;
    }
    try {
      if (!(await this.ctx.caddy.available())) return;
      const sink: string[] = [];
      const routes = caddyRoutesFromState(this.ctx, sink);
      await this.ctx.caddy.load(renderCaddyConfig(routes, { lan: caddyLanConsole(this.ctx.config) }));
      this.caddyApplied = want;
      this.ctx.log.info('caddy config reconciled', { publicRoutes: routes.length, lan: this.ctx.config.lan.enabled });
    } catch (e) {
      this.ctx.log.warn(`caddy reconcile failed: ${(e as Error).message}`);
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
