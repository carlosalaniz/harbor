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
import { listDevices } from '../system/host-storage.js';
import { checkHostDirectory } from '../storage/host-path.js';
import { verifyBindMarker, writeBindMarker } from '../storage/bind-marker.js';

// Periodic observation of what actually exists. Never mutates Docker.
export class Observer {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private caddyApplied: string | null = null;
  private lastSourceCheck = 0;
  private lastDevices: string | null = null;
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
      // Containers still running per instance (by inspection this tick): the
      // drive guard below uses it to decide whether a stop is needed.
      const runningByInstance = new Map<string, boolean>();
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
        runningByInstance.set(inst.id, running > 0);
      }
      this.notifyUpdatesAndDisk();
      this.notifyDevices();
      this.notifyMissingFolders(runningByInstance);
      this.autoStartRecovered(runningByInstance);
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

  // Removable media insert/remove: one info row per device, resolved when the
  // condition clears (reinserted / removed). Auto-mount runs here too (see
  // below): a fresh insert is mounted without asking when the policy allows.
  private notifyDevices(): void {
    let devices: { name: string; label: string | null; mounted: boolean; mountpoint: string | null }[];
    try {
      devices = listDevices();
    } catch {
      return;
    }
    const seen = new Set(devices.map((d) => d.name));
    const snapshot = JSON.stringify(devices.map((d) => `${d.name}:${d.mounted ? d.mountpoint : ''}`).sort());
    if (this.lastDevices !== null && snapshot !== this.lastDevices) {
      const prev = new Set((JSON.parse(this.lastDevices) as string[]).map((s) => s.split(':')[0]!));
      for (const d of devices) {
        if (!prev.has(d.name)) {
          this.ctx.notifier.notify({ kind: 'device-inserted', severity: 'info', title: `${d.label ?? d.name} connected`, body: d.mounted && d.mountpoint ? `Mounted at ${d.mountpoint}. Point an app at a folder on it from Settings → Storage.` : 'Inserted but not mounted. Mount it from Settings → Storage before pointing an app at it.', dedupeKey: `device:${d.name}` });
          this.autoMount(d.name, d.mounted);
        }
      }
      for (const name of prev) {
        if (!seen.has(name)) this.ctx.notifier.resolve(`device:${name}`);
      }
    }
    this.lastDevices = snapshot;
  }

  // Auto-mount a freshly inserted drive (policy on, device unmounted, mounter
  // wired): one mount per device name, failures notify once and never loop.
  // The mount lands at /mnt/<label>; the scan below then unlocks any waiting
  // apps whose folders reappear there.
  private readonly autoMountAttempts = new Set<string>();
  private autoMount(name: string, mounted: boolean): void {
    try {
      if (mounted) return;
      if ((this.ctx.repo.setting<boolean>('storage.autoMount') ?? true) !== true) return;
      const mounter = this.ctx.devices;
      if (!mounter) return;
      if (this.autoMountAttempts.has(name)) return;
      this.autoMountAttempts.add(name);
      void mounter
        .mount(name, 'auto-mount')
        .then(() => this.ctx.log.info(`auto-mounted ${name} on insert`, {}))
        .catch((e) => {
          this.autoMountAttempts.delete(name); // a later insert retries; same insert never loops
          this.ctx.notifier.notify({ kind: 'device-mount-failed', severity: 'warning', title: `Could not mount ${name} automatically`, body: `${e instanceof Error ? e.message : String(e)} Mount it from Settings → Storage.`, dedupeKey: `device-mount-failed:${name}` });
        });
    } catch (e) {
      this.ctx.log.warn(`auto-mount check failed: ${(e as Error).message}`);
    }
  }

  // An app folder that vanished or was swapped (drive removed, unmounted, or a
  // stranger's drive at the same path): stop the app through the normal queue
  // (plan → operation, actor drive-guard), error-notify per app, resolve when
  // the folder is back. The runner already refuses restarts against a missing
  // or foreign folder; this is the stop + bell half. One attempt per folder
  // state: a failed stop must not loop, and a stopped app is not re-stopped.
  private notifyMissingFolders(runningByInstance: Map<string, boolean>): void {
    try {
      for (const r of this.ctx.repo.resourcesByKind('bind')) {
        const key = `storage-missing:${r.instanceId}:${r.role}`;
        let reason: string | null = null;
        try {
          checkHostDirectory(r.name);
          const inst = this.ctx.repo.instance(r.instanceId);
          const storageId = (r.metadata?.['storageId'] as string | undefined) ?? r.role;
          let driveId = (r.metadata?.['driveId'] as string | undefined) ?? null;
          if (inst && !driveId) {
            // Pre-guard install: backfill the identity from the folder's
            // legacy marker (or stamp a fresh one) so the check below and
            // future ticks compare against a recorded id.
            try {
              driveId = writeBindMarker(r.name, inst.id, storageId);
              this.ctx.repo.upsertResource({ instanceId: inst.id, kind: 'bind', role: r.role, dockerId: r.dockerId, name: r.name, token: r.token, metadata: { ...(r.metadata ?? {}), storageId, driveId } });
            } catch {
              /* read-only folders stay unmarked; the verify below still applies */
            }
          }
          if (inst) verifyBindMarker(r.name, inst.id, storageId, driveId);
        } catch (e) {
          reason = e instanceof Error ? e.message : String(e);
        }
        if (reason) {
          const inst = this.ctx.repo.instance(r.instanceId);
          const purpose = (r.metadata?.['storageId'] as string | undefined) ?? r.role;
          this.ctx.notifier.notify({ kind: 'storage-missing', severity: 'error', title: `${inst?.displayName ?? inst?.name ?? 'An app'} lost its drive`, body: `${r.name} (${purpose}) is not the folder this app was using: ${reason} The app was stopped to protect its data. Re-insert the drive (or restore the folder with its marker) at the same path and start it again.`, instanceId: r.instanceId, dedupeKey: key });
          this.stopForMissingDrive(r.instanceId, r.name, reason, runningByInstance.get(r.instanceId) ?? false);
        } else {
          this.ctx.notifier.resolve(key);
        }
      }
    } catch {
      /* repo trouble is reported elsewhere */
    }
  }

  // Stop an app whose drive vanished: one queued stop plan per (instance,
  // folder-state), submitted like any other operation. Skips when the app is
  // already stopped, busy, or a stop was already attempted for this state.
  // Liveness comes from the same container inspection the tick already did:
  // callers pass whether any owned container is still running.
  private readonly driveStopAttempts = new Set<string>();
  private stopForMissingDrive(instanceId: string, folder: string, reason: string, anyRunning: boolean): void {
    try {
      const inst = this.ctx.repo.instance(instanceId);
      if (!inst || inst.installState !== 'installed' || inst.activeOperationId) return;
      if (inst.desired !== 'running' || !anyRunning) return;
      const attempt = `${instanceId}:${folder}:${reason}`;
      if (this.driveStopAttempts.has(attempt)) return;
      this.driveStopAttempts.add(attempt);
      void this.service
        .createPlan({ kind: 'stop', instanceId }, 'drive-guard')
        .then((plan) => {
          this.service.submit(plan.id, this.ctx.ids.uuid(), 'drive-guard');
          this.ctx.log.warn(`drive-guard stopped ${inst.name}: ${reason}`, { instanceId });
        })
        .catch((e) => this.ctx.log.warn(`drive-guard could not stop ${inst.name}: ${(e as Error).message}`, { instanceId }));
    } catch (e) {
      this.ctx.log.warn(`drive-guard check failed: ${(e as Error).message}`);
    }
  }

  // Auto-start apps whose drive came back: a drive-guard stop leaves desired
  // running (the stop only halts containers), so once the identity check
  // passes again the app is eligible. One attempt per (instance, folder):
  // the start plan itself refuses while the folder is still wrong, and a
  // failed start must not loop. Skips while the policy is off, the app is
  // busy, or anything is already queued for it.
  private readonly driveStartAttempts = new Set<string>();
  private autoStartRecovered(runningByInstance: Map<string, boolean>): void {
    try {
      if ((this.ctx.repo.setting<boolean>('storage.autoStart') ?? true) !== true) return;
      for (const inst of this.ctx.repo.listInstances()) {
        if (inst.installState !== 'installed' || inst.activeOperationId) continue;
        if (inst.desired !== 'running') continue;
        // Only apps the drive guard stopped: desired running but nothing running.
        if (runningByInstance.get(inst.id) ?? false) continue;
        const key = `storage-missing:${inst.id}`;
        const waiting = this.ctx.repo.notifications({ limit: 500 }).some((n) => n.dedupeKey.startsWith(key) && n.kind === 'storage-missing');
        if (!waiting) {
          // No outstanding drive complaint: forget past attempts so a future
          // pull/stop/start cycle can auto-start again.
          for (const k of [...this.driveStartAttempts]) if (k.startsWith(`${inst.id}:`)) this.driveStartAttempts.delete(k);
          continue;
        }
        // The folder must verify clean right now (backfilled identities
        // included) — otherwise the start plan would refuse anyway.
        let ready = true;
        let folder = '';
        try {
          for (const r of this.ctx.repo.resources(inst.id).filter((x) => x.kind === 'bind')) {
            folder = r.name;
            checkHostDirectory(r.name);
            const storageId = (r.metadata?.['storageId'] as string | undefined) ?? r.role;
            const driveId = (r.metadata?.['driveId'] as string | undefined) ?? null;
            verifyBindMarker(r.name, inst.id, storageId, driveId);
          }
        } catch {
          ready = false;
        }
        if (!ready) continue;
        const attempt = `${inst.id}:${folder}`;
        if (this.driveStartAttempts.has(attempt)) continue;
        this.driveStartAttempts.add(attempt);
        void this.service
          .createPlan({ kind: 'start', instanceId: inst.id }, 'drive-guard')
          .then((plan) => {
            this.service.submit(plan.id, this.ctx.ids.uuid(), 'drive-guard');
            this.ctx.log.warn(`drive-guard started ${inst.name}: its drive is back`, { instanceId: inst.id });
          })
          .catch((e) => this.ctx.log.warn(`drive-guard could not start ${inst.name}: ${(e as Error).message}`, { instanceId: inst.id }));
      }
    } catch (e) {
      this.ctx.log.warn(`drive-guard auto-start check failed: ${(e as Error).message}`);
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
