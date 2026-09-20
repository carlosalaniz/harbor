import path from 'node:path';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import type { Ctx } from './context.js';
import { HarborError, type ErrorCode } from '../errors.js';
import { ComposeError, type ContainerInfo } from '../docker/adapter.js';
import { LABELS } from '../naming.js';
import { defaultNetworkName, identityFor, ownedVolumeName, volumeLabels, type InstanceIdentity } from '../planner/identity.js';
import { renderCompose } from '../planner/render.js';
import { checkHostDirectory } from '../storage/host-path.js';
import { verifyBindMarker, writeBindMarker } from '../storage/bind-marker.js';
import type { LoadedPackage } from '../contracts/types.js';
import type { InstanceRow, OperationRow, PlanRow } from '../state/repo.js';
import { ensureInstanceDirs, generateSecretOnce, instanceDir, loadReleaseSnapshot, readSecret, writeReleaseSnapshot, writeRuntimeCompose } from './instance-dir.js';
import { waitReady } from './readiness.js';
import { exposureUrl, primaryUrlFor } from '../exposure/urls.js';
import { renderCaddyConfig, type CaddyLanConsole, type CaddyRoute } from '../exposure/caddy.js';
import { lanHostnames, machineAddresses } from '../system/lan.js';
import type { ExposureRow, PrimaryExposure } from '../state/repo.js';
import bcrypt from 'bcryptjs';

// Reserved secret id for the admin credential Harbor provisions at first install (decision 79).
export const PROVISIONED_SECRET = 'provisioned-password';

// Thrown when the daemon is shutting down while an operation waits. The operation is left in
// its in-flight state on purpose; the next daemon start marks it needs_action without replay.
export class InterruptedError extends Error {
  constructor() {
    super('daemon shutting down');
    this.name = 'InterruptedError';
  }
}

// One mutation at a time. Phase intent is persisted before side effects; created IDs after.
export class OperationRunner {
  private running = false;
  private stopping = false;
  private idle: Promise<void> = Promise.resolve();
  private opResult: Record<string, unknown> | null = null; // set by an operation to enrich the success result

  constructor(private readonly ctx: Ctx) {}

  // Mark leftovers from a previous process. Never replay.
  recoverOnStartup(): number {
    const { repo } = this.ctx;
    const stale = repo.activeOperations();
    for (const op of stale) {
      repo.transaction(() => {
        repo.finishOperation(op.id, 'needs_action', {
          errorCode: 'STATE_CHANGED',
          errorMessage: `operation was ${op.state} (${op.phase}) when the daemon stopped; its effects were not replayed`,
          nextAction: 'Inspect the instance. Use stop/remove after confirming ownership; do not assume the operation completed.',
        });
        repo.addEvent({ operationId: op.id, instanceId: op.instanceId, phase: 'needs_action', message: 'daemon restarted while the operation was in flight' });
        const inst = repo.instance(op.instanceId);
        if (inst) {
          repo.updateInstance(inst.id, { activeOperationId: null, lastOperationId: op.id, installState: 'needs_action', runtime: 'unknown', readiness: 'unknown' });
          repo.bumpGeneration(inst.id);
        }
      });
    }
    return stale.length;
  }

  wake(): void {
    if (this.running || this.stopping) return;
    this.running = true;
    this.idle = this.loop().finally(() => {
      this.running = false;
    });
  }

  async drain(): Promise<void> {
    await this.idle;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.idle;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const op = this.ctx.repo.nextQueuedOperation();
      if (!op) return;
      await this.execute(op);
    }
  }

  private event(op: OperationRow, phase: string, message: string): void {
    this.ctx.repo.addEvent({ operationId: op.id, instanceId: op.instanceId, phase, message });
    this.ctx.log.info(message, { operationId: op.id, instanceId: op.instanceId, phase });
  }

  private phase(op: OperationRow, state: 'applying' | 'verifying', phase: string, message: string): void {
    this.ctx.repo.setOperationPhase(op.id, state, phase);
    this.event(op, phase, message);
  }

  private async execute(op: OperationRow): Promise<void> {
    const { repo } = this.ctx;
    const plan = repo.plan(op.planId);
    const inst = repo.instance(op.instanceId);
    if (!plan || !inst) {
      repo.finishOperation(op.id, 'failed', { errorCode: 'STATE_CHANGED', errorMessage: 'plan or instance vanished', nextAction: 'Inspect state.' });
      return;
    }
    const secretValues: string[] = [];
    this.opResult = null;
    try {
      if (this.stopping) throw new InterruptedError();
      switch (op.kind) {
        case 'install': await this.install(op, plan, inst, secretValues); break;
        case 'reinstall': await this.reinstall(op, plan, inst, secretValues); break;
        case 'start': await this.start(op, plan, inst); break;
        case 'stop': await this.stop(op, inst, plan.actor); break;
        case 'remove': await this.remove(op, inst); break;
        case 'purge': await this.purge(op, inst); break;
        case 'update': await this.update(op, plan, inst, secretValues); break;
        case 'expose': await this.expose(op, plan, inst, secretValues); break;
        case 'unexpose': await this.unexpose(op, plan, inst, secretValues); break;
        case 'reconfigure': await this.reconfigure(op, plan, inst, secretValues); break;
      }
      const result = { instanceId: inst.id, name: inst.name, ...(this.opResult ?? {}) };
      this.opResult = null;
      repo.transaction(() => {
        repo.finishOperation(op.id, 'succeeded', { result });
        repo.updateInstance(inst.id, { activeOperationId: null, lastOperationId: op.id });
        repo.bumpGeneration(inst.id);
        repo.addEvent({ operationId: op.id, instanceId: inst.id, phase: 'succeeded', message: `${op.kind} succeeded` });
      });
    } catch (e) {
      if (e instanceof InterruptedError) {
        this.ctx.log.warn(`${op.kind} interrupted by shutdown; left in state ${repo.operation(op.id)?.state} for recovery`, { operationId: op.id });
        return;
      }
      const { code, message, nextAction, state } = classify(e, secretValues);
      // a failed update that was rolled back leaves the app installed and running on the previous release
      const rolledBack = op.kind === 'update' && this.opResult?.['rolledBack'] === true;
      const result = rolledBack ? { instanceId: inst.id, name: inst.name, ...(this.opResult ?? {}) } : undefined;
      this.opResult = null;
      this.ctx.log.warn(`${op.kind} ${state}: ${message}`, { operationId: op.id, instanceId: inst.id, code });
      repo.transaction(() => {
        repo.finishOperation(op.id, state, { errorCode: code, errorMessage: message, nextAction, ...(result ? { result } : {}) });
        repo.updateInstance(inst.id, {
          activeOperationId: null,
          lastOperationId: op.id,
          installState: rolledBack ? 'installed' : installStateAfterFailure(op.kind, repo.resources(inst.id).some((r) => r.kind === 'container'), inst.installState),
          readiness: rolledBack ? 'healthy' : 'unknown',
        });
        repo.bumpGeneration(inst.id);
        repo.addEvent({ operationId: op.id, instanceId: inst.id, phase: state, message: `${op.kind} ${state}: ${message}` });
      });
      // One row per failed operation (unique id in the key): auto-updates and background redeploys surface here.
      this.ctx.notifier.notify({
        kind: 'operation-failed',
        severity: 'error',
        title: rolledBack ? `Update of ${inst.name} failed; the previous version is back` : `${op.kind} of ${inst.name} ${state === 'needs_action' ? 'needs attention' : 'failed'}`,
        body: `${message} Next: ${nextAction}`,
        instanceId: inst.id,
        dedupeKey: `operation-failed:${op.id}`,
      });
    }
  }

  // ---------- shared steps

  private dirs(inst: InstanceRow) {
    return ensureInstanceDirs(this.ctx.config.stateDir, inst.id);
  }

  private async engineOrThrow(): Promise<void> {
    const ping = await this.ctx.docker.ping();
    if (!ping.available) throw new HarborError('DOCKER_UNAVAILABLE', `Docker Engine is not reachable: ${ping.error ?? 'unknown error'}`);
  }

  private async createOwnedVolumes(op: OperationRow, pkg: LoadedPackage, identity: InstanceIdentity, inst: InstanceRow, planned: PlanRow['proposal']['storage']): Promise<void> {
    const { docker, repo, ids } = this.ctx;
    for (const claim of pkg.manifest.storage ?? []) {
      const choice = planned.find((s) => s.id === claim.id);
      if (choice?.hostPath) {
        // Operator-chosen folder: re-checked now (the plan may be minutes old); recorded as a 'bind' resource. Never created or chowned.
        const { path: hostPath } = checkHostDirectory(choice.hostPath);
        // App-generated drive identity: a fresh folder (or a replacement drive) gets a new
        // random id stamped into its marker; a restored folder keeps the id it carries, so a
        // dead drive recovered from backup keeps working. The id is stored on the resource
        // so later checks can tell "right drive, temporarily gone" from "wrong drive".
        const driveId = writeBindMarker(hostPath, inst.id, claim.id);
        repo.upsertResource({ instanceId: inst.id, kind: 'bind', role: claim.composeVolume, dockerId: null, name: hostPath, token: null, metadata: { storageId: claim.id, readOnly: choice.readOnly ?? false, driveId } });
        this.event(op, 'preparing', `using your folder ${hostPath} for ${claim.purpose}${choice.readOnly ? ' (read-only)' : ''}`);
        continue;
      }
      const name = ownedVolumeName(identity, claim.composeVolume);
      const existing = await docker.inspectVolume(name);
      if (existing) {
        throw new HarborError('OWNERSHIP_CONFLICT', `volume ${name} already exists and was not created by this instance`, {
          nextAction: 'Inspect the volume manually. Harbor never reuses or deletes a volume it did not create for this instance.',
        });
      }
      const token = ids.token(16).toString('hex');
      const created = await docker.createVolume(name, volumeLabels(identity, claim.composeVolume, token));
      repo.upsertResource({ instanceId: inst.id, kind: 'volume', role: claim.composeVolume, dockerId: null, name, token, metadata: { createdAt: created.createdAt, storageId: claim.id } });
      this.event(op, 'preparing', `created retained volume ${name}`);
    }
  }

  private async verifyOwnedVolumes(op: OperationRow, pkg: LoadedPackage, identity: InstanceIdentity, inst: InstanceRow): Promise<void> {
    const { docker, repo } = this.ctx;
    const all = repo.resources(inst.id);
    const resources = all.filter((r) => r.kind === 'volume');
    for (const claim of pkg.manifest.storage ?? []) {
      const bind = all.find((r) => r.kind === 'bind' && r.role === claim.composeVolume);
      if (bind) {
        try {
          checkHostDirectory(bind.name);
          // A legacy marker (no drive id) verifies by instance + claim alone;
          // backfill the resource so future comparisons have an id.
          let driveId = (bind.metadata?.['driveId'] as string | undefined) ?? null;
          if (!driveId) {
            driveId = writeBindMarker(bind.name, inst.id, claim.id);
            repo.upsertResource({ instanceId: inst.id, kind: 'bind', role: bind.role, dockerId: bind.dockerId, name: bind.name, token: bind.token, metadata: { ...(bind.metadata ?? {}), storageId: claim.id, driveId } });
          }
          verifyBindMarker(bind.name, inst.id, claim.id, driveId);
        } catch (e) {
          throw new HarborError('DATA_MISSING', `your folder ${bind.name} (${claim.purpose}) is not available: ${e instanceof Error ? e.message : String(e)}`, { nextAction: 'Mount or restore the folder at the same path, then retry. Harbor will not start the app against a missing folder.' });
        }
        this.event(op, 'preparing', `verified your folder ${bind.name}`);
        continue;
      }
      const rec = resources.find((r) => r.role === claim.composeVolume);
      const name = ownedVolumeName(identity, claim.composeVolume);
      if (!rec) throw new HarborError('DATA_MISSING', `no ownership record for volume ${name}`);
      const vol = await docker.inspectVolume(rec.name);
      if (!vol) throw new HarborError('DATA_MISSING', `retained volume ${rec.name} no longer exists`, { nextAction: 'The data volume is gone. Restore it from your own backup or remove the instance; Harbor will not create an empty replacement.' });
      const createdAt = (rec.metadata?.['createdAt'] as string | null) ?? null;
      if (vol.labels[LABELS.token] !== rec.token || vol.labels[LABELS.instance] !== inst.id || (createdAt && vol.createdAt && vol.createdAt !== createdAt)) {
        throw new HarborError('DATA_MISSING', `volume ${rec.name} exists but is not the one this instance created (ownership token or creation time differs)`, {
          nextAction: 'A different volume now uses this name. Investigate manually before continuing; nothing was started.',
        });
      }
      this.event(op, 'preparing', `verified retained volume ${rec.name}`);
    }
  }

  private generateSecrets(op: OperationRow, pkg: LoadedPackage, inst: InstanceRow, secretsDir: string): void {
    const refs = [...inst.secrets];
    for (const s of pkg.manifest.secrets ?? []) {
      const created = generateSecretOnce(secretsDir, s.id, this.ctx.ids);
      if (!created) throw new HarborError('OWNERSHIP_CONFLICT', `secret ${s.id} already exists for a fresh instance`, { nextAction: 'Inspect the instance directory manually.' });
      if (!refs.some((r) => r.id === s.id)) refs.push({ id: s.id, file: path.join('secrets', s.id) });
      this.event(op, 'preparing', `generated retained secret ${s.id}`);
    }
    // decision 79: the admin credential Harbor provisions is a retained secret like any other
    if (pkg.manifest.provisionedCredentials) {
      const created = generateSecretOnce(secretsDir, PROVISIONED_SECRET, this.ctx.ids);
      if (created) this.event(op, 'preparing', 'generated the admin credential for this app (shown once when the install finishes)');
      if (!refs.some((r) => r.id === PROVISIONED_SECRET)) refs.push({ id: PROVISIONED_SECRET, file: path.join('secrets', PROVISIONED_SECRET) });
    }
    this.ctx.repo.updateInstance(inst.id, { secrets: refs });
  }

  private readSecrets(pkg: LoadedPackage, secretsDir: string, sink: string[]): Record<string, string> {
    const values: Record<string, string> = {};
    for (const s of pkg.manifest.secrets ?? []) {
      values[s.id] = readSecret(secretsDir, s.id);
      sink.push(values[s.id]!);
    }
    return values;
  }

  // The credential provisioned at first install (decision 79); stable across reinstall/update/reconfigure.
  private readProvisioned(pkg: LoadedPackage, secretsDir: string, sink: string[]): { username: string; password: string } | null {
    const pc = pkg.manifest.provisionedCredentials;
    if (!pc) return null;
    const password = readSecret(secretsDir, PROVISIONED_SECRET);
    sink.push(password);
    return { username: pc.username ?? 'admin', password };
  }

  // Same, resolved from the instance directory (render paths that did not read it explicitly).
  private provisionedFor(pkg: LoadedPackage, inst: InstanceRow): { username: string; password: string } | null {
    const pc = pkg.manifest.provisionedCredentials;
    if (!pc) return null;
    return { username: pc.username ?? 'admin', password: readSecret(this.dirs(inst).secrets, PROVISIONED_SECRET) };
  }

  // Build git-sourced services locally (decision 80). Contexts are the snapshot's build/<service>/
  // folders — the exact bytes the import validated. 15-minute cap per service.
  private async buildImages(op: OperationRow, pkg: LoadedPackage, packageDir: string): Promise<void> {
    const builds = Object.entries(pkg.release.builds ?? {});
    if (!builds.length) return;
    for (const [service, b] of builds) {
      const contextDir = path.join(packageDir, 'build', service);
      if (!existsSync(contextDir)) throw new HarborError('DATA_MISSING', `build context for service ${service} is missing from the package`, { nextAction: 'Check the package source and re-add it.' });
      this.phase(op, 'applying', 'building', `building ${service} from commit ${b.commit.slice(0, 12)} (${b.tag})`);
      await this.ctx.compose.build({ contextDir, dockerfile: b.dockerfile ?? 'Dockerfile', tag: b.tag, timeoutMs: 15 * 60_000, onLog: (line) => this.event(op, 'building', line.slice(0, 300)) });
      this.event(op, 'building', `built ${b.tag} from commit ${b.commit.slice(0, 12)}`);
    }
  }

  // URLs handed to `configuration` bindings follow the instance's primary exposure.
  private endpointUrlsFor(inst: InstanceRow, primary: PrimaryExposure = inst.primaryExposure): Record<string, string> {
    const exposures = this.ctx.repo.exposures(inst.id);
    return Object.fromEntries(inst.endpoints.map((e) => [e.id, primaryUrlFor(e, exposures, primary)]));
  }

  private async renderAndValidate(op: OperationRow, pkg: LoadedPackage, identity: InstanceIdentity, inst: InstanceRow, runtimeDir: string, secretValues: Record<string, string>, primary?: PrimaryExposure, provisioned?: { username: string; password: string } | null): Promise<string> {
    const externalStorage = Object.fromEntries(this.ctx.repo.resources(inst.id).filter((r) => r.kind === 'bind').map((r) => [r.role, { hostPath: r.name, readOnly: Boolean(r.metadata?.['readOnly']) }]));
    const builtImages = Object.fromEntries(Object.entries(pkg.release.builds ?? {}).map(([svc, b]) => [svc, b.tag]));
    const rendered = renderCompose({ manifest: pkg.manifest, compose: pkg.compose, identity, endpoints: inst.endpoints, secretValues, endpointUrls: this.endpointUrlsFor(inst, primary), externalStorage, bindHost: this.ctx.config.lan.enabled ? '0.0.0.0' : '127.0.0.1', provisioned: provisioned ?? this.provisionedFor(pkg, inst), builtImages });
    const file = writeRuntimeCompose(runtimeDir, rendered.yaml);
    try {
      await this.ctx.compose.config({ projectDir: runtimeDir, projectName: identity.project, file }, 60_000);
    } catch (e) {
      if (e instanceof ComposeError) throw new HarborError('INVALID_PACKAGE', `Compose rejected the generated model: ${e.message}`);
      throw e;
    }
    this.event(op, 'preparing', 'generated private Compose file and validated it with Compose');
    return file;
  }

  private async recordProjectResources(op: OperationRow, identity: InstanceIdentity, inst: InstanceRow): Promise<ContainerInfo[]> {
    const { docker, repo } = this.ctx;
    const containers = await docker.listContainers({ all: true, labels: { 'com.docker.compose.project': identity.project } });
    for (const c of containers) {
      if (c.labels[LABELS.instance] !== inst.id || c.labels[LABELS.installation] !== identity.installationId) {
        throw new HarborError('OWNERSHIP_CONFLICT', `container ${c.name} in project ${identity.project} does not carry this instance's ownership labels`);
      }
      const service = c.labels['com.docker.compose.service'] ?? c.name;
      repo.upsertResource({ instanceId: inst.id, kind: 'container', role: service, dockerId: c.id, name: c.name, token: null, metadata: { createdAt: c.createdAt, image: c.image } });
    }
    const net = await docker.inspectNetwork(defaultNetworkName(identity));
    if (net) repo.upsertResource({ instanceId: inst.id, kind: 'network', role: 'default', dockerId: net.id, name: net.name, token: null, metadata: null });
    this.event(op, 'starting', `recorded ${containers.length} owned container(s)${net ? ' and the project network' : ''}`);
    return containers;
  }

  private async checkReadiness(op: OperationRow, pkg: LoadedPackage, inst: InstanceRow, containers: ContainerInfo[]): Promise<void> {
    const { repo, clock } = this.ctx;
    const health = pkg.manifest.health;
    const ep = pkg.manifest.endpoints[health.endpoint]!;
    const alloc = inst.endpoints.find((e) => e.id === health.endpoint);
    if (!alloc) throw new HarborError('STATE_CHANGED', `no allocation for health endpoint ${health.endpoint}`);
    const container = containers.find((c) => c.labels['com.docker.compose.service'] === ep.service);
    if (!container || container.state !== 'running') throw new HarborError('OPERATION_FAILED', `service ${ep.service} is not running after start`);
    const okHost = (ip: string) => ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '' || ip === '::';
    const bound = container.ports.some((p) => okHost(p.hostIp) && p.hostPort === alloc.hostPort && p.containerPort === alloc.containerPort);
    if (!bound) throw new HarborError('OPERATION_FAILED', `container ${container.name} does not publish ${alloc.hostPort}->${alloc.containerPort} on this machine; refusing to probe an unrelated listener`);
    this.ctx.repo.setOperationPhase(op.id, 'verifying', 'checking');
    repo.updateInstance(inst.id, { runtime: 'running', readiness: 'checking', observedAt: repo.now() });
    this.event(op, 'checking', `probing http://127.0.0.1:${alloc.hostPort}${health.path} (deadline ${health.deadlineSeconds}s)`);
    let lastLogged = 0;
    const result = await waitReady(
      { hostPort: alloc.hostPort, path: health.path, expectedStatus: health.expectedStatus, timeoutSeconds: health.timeoutSeconds, deadlineSeconds: health.deadlineSeconds },
      clock,
      (r, attempt) => {
        if (!r.ok && attempt - lastLogged >= 10) {
          lastLogged = attempt;
          this.event(op, 'checking', `readiness attempt ${attempt}: ${r.status ?? r.error}`);
        }
      },
      () => this.stopping,
    );
    if (this.stopping && !result.ok) throw new InterruptedError();
    if (!result.ok) {
      repo.updateInstance(inst.id, { readiness: 'unhealthy', observedAt: repo.now() });
      throw new HarborError('READINESS_TIMEOUT', `readiness check did not pass within ${health.deadlineSeconds}s (last: ${result.last.status ?? result.last.error}); containers were kept for inspection`);
    }
    this.event(op, 'checking', `readiness passed after ${result.attempts} attempt(s) with status ${result.last.status}`);
  }

  // ---------- exposure

  private basicSecretId(endpointId: string): string {
    return basicSecretIdFor(endpointId);
  }

  // Full Caddy reconcile from state: every public exposure becomes one route (+ the LAN console server in LAN mode).
  private async reconcileCaddy(op: OperationRow, sink: string[]): Promise<void> {
    const routes = caddyRoutesFromState(this.ctx, sink);
    await this.ctx.caddy.load(renderCaddyConfig(routes, { lan: caddyLanConsole(this.ctx.config) }));
    this.event(op, 'applying', `reconciled ${routes.length} public route(s) in Caddy`);
  }

  private async withdrawExposure(op: OperationRow, e: ExposureRow): Promise<void> {
    if (e.via === 'tailnet') {
      const inst = this.ctx.repo.instance(e.instanceId);
      const alloc = inst?.endpoints.find((a) => a.id === e.endpointId);
      await this.ctx.tailscale.unserve(e.port, `http://127.0.0.1:${alloc?.hostPort ?? e.port}`);
    } else {
      this.ctx.repo.updateExposure(e.id, { state: 'removing' });
      await this.reconcileCaddy(op, []);
    }
  }

  private async expose(op: OperationRow, plan: PlanRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo, ids } = this.ctx;
    const x = plan.proposal.exposure;
    if (!x) throw new HarborError('STATE_CHANGED', 'plan carries no exposure');
    this.phase(op, 'applying', 'publishing', `publishing ${exposureUrl(x)} via ${x.via}`);
    const alloc = inst.endpoints.find((a) => a.id === x.endpointId);
    if (!alloc) throw new HarborError('STATE_CHANGED', `endpoint ${x.endpointId} is not allocated`);
    if (repo.exposureByAddress(x.via, x.hostname, x.port)) throw new HarborError('NAME_CONFLICT', `${exposureUrl(x)} is already used by another exposure`);
    const dirs = this.dirs(inst);
    let credentials: { username: string; password: string } | null = null;
    if (x.protection === 'basic') {
      const created = generateSecretOnce(dirs.secrets, this.basicSecretId(x.endpointId), ids);
      const value = readSecret(dirs.secrets, this.basicSecretId(x.endpointId));
      sink.push(value);
      credentials = { username: 'harbor', password: value };
      this.event(op, 'publishing', created ? 'generated retained basic-auth credentials' : 'reusing retained basic-auth credentials');
      if (!inst.secrets.some((s) => s.id === this.basicSecretId(x.endpointId))) repo.updateInstance(inst.id, { secrets: [...inst.secrets, { id: this.basicSecretId(x.endpointId), file: path.join('secrets', this.basicSecretId(x.endpointId)) }] });
    }
    const exposureId = ids.uuid();
    repo.insertExposure({ id: exposureId, instanceId: inst.id, endpointId: x.endpointId, via: x.via, hostname: x.hostname, port: x.port, protection: x.protection, state: 'pending', note: null });
    const row = repo.exposure(exposureId)!;
    if (x.via === 'tailnet') {
      await this.ctx.tailscale.serve(x.port, `http://127.0.0.1:${alloc.hostPort}`);
      this.event(op, 'publishing', `tailscale serve --https=${x.port} -> 127.0.0.1:${alloc.hostPort}`);
    } else {
      await this.reconcileCaddy(op, sink);
    }
    if (x.makePrimary) {
      await this.applyPrimary(op, inst, x.via, sink);
    }
    this.ctx.repo.setOperationPhase(op.id, 'verifying', 'checking');
    const url = exposureUrl(row);
    this.event(op, 'checking', `verifying ${url} answers over HTTPS (certificate issuance may take a minute)`);
    const deadline = this.ctx.clock.now().getTime() + 120_000;
    let last = await this.ctx.verify(url);
    while (!last.ok && this.ctx.clock.now().getTime() < deadline && !this.stopping) {
      await new Promise((r) => setTimeout(r, 5000));
      last = await this.ctx.verify(url);
    }
    const now = repo.now();
    if (last.ok) {
      repo.updateExposure(exposureId, { state: 'active', observedAt: now, note: `answered HTTP ${last.status}` });
      this.event(op, 'checking', `${url} answers (HTTP ${last.status})`);
    } else {
      repo.updateExposure(exposureId, { state: 'degraded', observedAt: now, note: `not reachable yet: ${last.error ?? `HTTP ${last.status}`}. ${x.via === 'public' ? 'Check the DNS record and that ports 80/443 reach this host; Harbor keeps re-checking.' : 'Check tailnet HTTPS certificates; Harbor keeps re-checking.'}` });
      this.event(op, 'checking', `${url} not reachable yet (${last.error ?? `HTTP ${last.status}`}); exposure recorded as degraded and re-checked periodically`);
    }
    // Credentials appear once, in this operation's result; they are never in DTOs or logs afterwards.
    this.opResult = { exposureId, url, exposureState: last.ok ? 'active' : 'degraded', ...(credentials ? { credentials } : {}) };
  }

  private async unexpose(op: OperationRow, plan: PlanRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo } = this.ctx;
    const x = plan.proposal.exposure;
    if (!x) throw new HarborError('STATE_CHANGED', 'plan carries no exposure');
    const e = repo.exposureFor(inst.id, x.endpointId, x.via);
    if (!e) throw new HarborError('STATE_CHANGED', `${inst.name}/${x.endpointId} is no longer exposed via ${x.via}`);
    this.phase(op, 'applying', 'withdrawing', `withdrawing ${exposureUrl(e)}`);
    if (plan.proposal.primary === 'loopback' && inst.primaryExposure === x.via) await this.applyPrimary(op, inst, 'loopback', sink);
    await this.withdrawExposure(op, e);
    repo.deleteExposure(e.id);
    this.event(op, 'withdrawing', `${exposureUrl(e)} withdrawn; credentials (if any) retained as an instance secret`);
  }

  private async reconfigure(op: OperationRow, plan: PlanRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const primary = plan.proposal.primary;
    if (!primary) throw new HarborError('STATE_CHANGED', 'plan carries no primary exposure');
    this.phase(op, 'applying', 'reconfiguring', `switching the primary address of ${inst.name} to ${primary}`);
    await this.applyPrimary(op, inst, primary, sink);
  }

  // Re-render with the new base URL and recreate only if the package has configuration bindings.
  private async applyPrimary(op: OperationRow, inst: InstanceRow, primary: PrimaryExposure, sink: string[]): Promise<void> {
    const { repo } = this.ctx;
    const dirs = this.dirs(inst);
    const pkg = loadReleaseSnapshot(dirs.release, inst.packageId);
    repo.updateInstance(inst.id, { primaryExposure: primary });
    if (!(pkg.manifest.configuration ?? []).length) {
      this.event(op, 'reconfiguring', `primary address is now ${primary}; ${pkg.manifest.metadata.name} does not embed its base URL, containers unchanged`);
      return;
    }
    await this.engineOrThrow();
    const identity = identityFor(this.ctx.installationId, inst.id);
    const values = this.readSecrets(pkg, dirs.secrets, sink);
    const file = await this.renderAndValidate(op, pkg, identity, inst, dirs.runtime, values, primary);
    const inv = { projectDir: dirs.runtime, projectName: identity.project, file };
    this.event(op, 'reconfiguring', 'recreating containers whose configuration changed (same volumes, secrets and ports)');
    repo.updateInstance(inst.id, { runtime: 'starting' });
    const containers = await this.upAndRecord(op, inv, identity, inst);
    await this.checkReadiness(op, pkg, inst, containers);
    repo.updateInstance(inst.id, { runtime: 'running', readiness: 'healthy', observedAt: repo.now() });
  }

  // ---------- operations

  private async install(op: OperationRow, plan: PlanRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo, config } = this.ctx;
    this.phase(op, 'applying', 'preparing', 'revalidating package and plan');
    await this.engineOrThrow();
    const pkg = this.ctx.packages.load(inst.packageId, inst.revision);
    for (const [f, h] of Object.entries(plan.proposal.releaseHashes)) {
      if (pkg.hashes[f as keyof typeof pkg.hashes] !== h) throw new HarborError('STATE_CHANGED', `package ${f} changed since the plan was created`);
    }
    const identity = identityFor(this.ctx.installationId, inst.id);
    const dirs = this.dirs(inst);
    writeReleaseSnapshot(dirs.release, pkg);
    this.event(op, 'preparing', `stored release snapshot for ${pkg.id} revision ${pkg.revision}`);
    await this.createOwnedVolumes(op, pkg, identity, inst, plan.proposal.storage);
    this.generateSecrets(op, pkg, inst, dirs.secrets);
    const values = this.readSecrets(pkg, dirs.secrets, sink);
    const provisioned = this.readProvisioned(pkg, dirs.secrets, sink);
    const file = await this.renderAndValidate(op, pkg, identity, inst, dirs.runtime, values, undefined, provisioned);
    const inv = { projectDir: dirs.runtime, projectName: identity.project, file };

    await this.buildImages(op, pkg, dirs.release);
    if (Object.keys(pkg.release.images).length) {
      this.phase(op, 'applying', 'pulling', `pulling ${Object.keys(pkg.release.images).length} image(s) by digest`);
      await this.ctx.compose.pull(inv, config.imagePullTimeoutMs);
    }

    this.phase(op, 'applying', 'starting', 'creating and starting the Compose project');
    repo.updateInstance(inst.id, { runtime: 'starting' });
    const containers = await this.upAndRecord(op, inv, identity, inst);
    await this.checkReadiness(op, pkg, inst, containers);
    repo.updateInstance(inst.id, { installState: 'installed', everInstalled: true, desired: 'running', runtime: 'running', readiness: 'healthy', observedAt: repo.now() });
    // The provisioned admin credential appears once, in this operation's result (same UX as exposure basic-auth).
    if (provisioned) this.opResult = { ...(this.opResult ?? {}), credentials: provisioned, ...(pkg.manifest.provisionedCredentials?.note ? { credentialsNote: pkg.manifest.provisionedCredentials.note } : {}) };
  }

  // `compose up`, then record what exists under our labels. On failure, still record (best effort)
  // so that inspect/remove can see and clean up partially created resources.
  private async upAndRecord(op: OperationRow, inv: { projectDir: string; projectName: string; file: string }, identity: InstanceIdentity, inst: InstanceRow): Promise<ContainerInfo[]> {
    try {
      await this.ctx.compose.up(inv, this.ctx.config.startTimeoutMs);
    } catch (e) {
      try {
        await this.recordProjectResources(op, identity, inst);
      } catch (re) {
        this.ctx.log.warn(`could not record project resources after failed up: ${(re as Error).message}`, { operationId: op.id });
      }
      throw e;
    }
    return this.recordProjectResources(op, identity, inst);
  }

  private async reinstall(op: OperationRow, _plan: PlanRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo, config } = this.ctx;
    this.phase(op, 'applying', 'preparing', 'loading stored release and verifying retained data');
    await this.engineOrThrow();
    const dirs = this.dirs(inst);
    const pkg = loadReleaseSnapshot(dirs.release, inst.packageId);
    for (const [f, h] of Object.entries(inst.releaseHashes)) {
      if (pkg.hashes[f as keyof typeof pkg.hashes] !== h) throw new HarborError('DATA_MISSING', `stored release snapshot ${f} does not match the recorded hash`);
    }
    const identity = identityFor(this.ctx.installationId, inst.id);
    await this.verifyOwnedVolumes(op, pkg, identity, inst);
    const values = this.readSecrets(pkg, dirs.secrets, sink);
    this.event(op, 'preparing', `verified ${Object.keys(values).length} retained secret(s)`);
    const existing = await this.ctx.docker.listContainers({ all: true, labels: { 'com.docker.compose.project': identity.project } });
    for (const c of existing) {
      if (c.labels[LABELS.instance] !== inst.id) throw new HarborError('OWNERSHIP_CONFLICT', `container ${c.name} occupies project ${identity.project} but is not owned by this instance`);
    }
    const file = await this.renderAndValidate(op, pkg, identity, inst, dirs.runtime, values);
    const inv = { projectDir: dirs.runtime, projectName: identity.project, file };
    repo.updateInstance(inst.id, { installState: 'installing', desired: 'running' });

    await this.buildImages(op, pkg, dirs.release);
    if (Object.keys(pkg.release.images).length) {
      this.phase(op, 'applying', 'pulling', 'pulling exact stored images');
      await this.ctx.compose.pull(inv, config.imagePullTimeoutMs);
    }
    this.phase(op, 'applying', 'starting', 'recreating containers and network');
    repo.updateInstance(inst.id, { runtime: 'starting' });
    const containers = await this.upAndRecord(op, inv, identity, inst);
    await this.checkReadiness(op, pkg, inst, containers);
    repo.updateInstance(inst.id, { installState: 'installed', everInstalled: true, desired: 'running', runtime: 'running', readiness: 'healthy', observedAt: repo.now() });
  }

  private async start(op: OperationRow, _plan: PlanRow, inst: InstanceRow): Promise<void> {
    const { repo, docker, config } = this.ctx;
    this.phase(op, 'applying', 'preparing', 'verifying release, data and secrets before start');
    await this.engineOrThrow();
    const dirs = this.dirs(inst);
    const pkg = loadReleaseSnapshot(dirs.release, inst.packageId);
    const identity = identityFor(this.ctx.installationId, inst.id);
    await this.verifyOwnedVolumes(op, pkg, identity, inst);
    for (const s of pkg.manifest.secrets ?? []) readSecret(dirs.secrets, s.id);
    const recorded = repo.resources(inst.id).filter((r) => r.kind === 'container');
    if (!recorded.length) throw new HarborError('DATA_MISSING', 'no recorded containers for this instance; start cannot recreate them', { nextAction: 'Use remove and then reinstall if the instance was previously installed.' });
    for (const r of recorded) {
      const c = await docker.inspectContainer(r.dockerId ?? r.name);
      if (!c) throw new HarborError('DATA_MISSING', `recorded container ${r.name} no longer exists`, { nextAction: 'Containers are missing. Use remove, then reinstall into the retained instance.' });
      if (c.labels[LABELS.instance] !== inst.id) throw new HarborError('OWNERSHIP_CONFLICT', `container ${r.name} is not owned by this instance`);
    }
    repo.updateInstance(inst.id, { desired: 'running' });
    this.phase(op, 'applying', 'starting', 'starting existing containers');
    repo.updateInstance(inst.id, { runtime: 'starting' });
    const file = path.join(dirs.runtime, 'compose.yaml');
    await this.ctx.compose.start({ projectDir: dirs.runtime, projectName: identity.project, file }, config.startTimeoutMs);
    const containers = await this.recordProjectResources(op, identity, inst);
    await this.checkReadiness(op, pkg, inst, containers);
    repo.updateInstance(inst.id, { installState: 'installed', runtime: 'running', readiness: 'healthy', observedAt: repo.now() });
  }

  private async stop(op: OperationRow, inst: InstanceRow, actor: string): Promise<void> {
    const { repo, docker } = this.ctx;
    this.phase(op, 'applying', 'stopping', 'persisting desired state stopped');
    await this.engineOrThrow();
    // A drive-guard stop halts containers but leaves desired running: the app
    // was healthy and should come back by itself once its drive is back (the
    // observer's auto-start handles that). Operator stops keep desired stopped.
    const guardStop = actor === 'drive-guard';
    if (!guardStop) repo.updateInstance(inst.id, { desired: 'stopped' });
    const recorded = repo.resources(inst.id).filter((r) => r.kind === 'container');
    // Application services first, then infrastructure, so dependents shut down before their dependencies.
    for (const r of recorded) {
      const c = await docker.inspectContainer(r.dockerId ?? r.name);
      if (!c) {
        this.event(op, 'stopping', `container ${r.name} is already absent`);
        continue;
      }
      if (c.labels[LABELS.instance] !== inst.id) throw new HarborError('OWNERSHIP_CONFLICT', `container ${r.name} is not owned by this instance; not stopping it`);
      if (c.state === 'running' || c.state === 'restarting' || c.state === 'paused') {
        await docker.stopContainer(c.id, 15);
        this.event(op, 'stopping', `stopped ${c.name}`);
      }
    }
    for (const r of recorded) {
      const c = await docker.inspectContainer(r.dockerId ?? r.name);
      if (c && c.state === 'running') throw new HarborError('OPERATION_FAILED', `container ${r.name} is still running after stop`);
    }
    repo.updateInstance(inst.id, { runtime: 'stopped', readiness: 'unknown', observedAt: repo.now() });
  }

  // Full uninstall: remove (if needed), then delete every Docker volume this instance created (ownership
  // verified by labels first), its secrets and release snapshot, and leave every namespace (name, ports).
  // Folders of the operator's own ("bind" resources) are never touched.
  private async purge(op: OperationRow, inst: InstanceRow): Promise<void> {
    const { repo, docker } = this.ctx;
    if (inst.installState !== 'retained') await this.remove(op, inst);
    this.phase(op, 'applying', 'purging', 'deleting retained data of this app (verified as Harbor-created first)');
    const resources = repo.resources(inst.id);
    for (const r of resources.filter((x) => x.kind === 'volume')) {
      const vol = await docker.inspectVolume(r.name);
      if (!vol) {
        this.event(op, 'purging', `volume ${r.name} already absent`);
        repo.deleteResource(inst.id, 'volume', r.role);
        continue;
      }
      if (vol.labels[LABELS.instance] !== inst.id || (r.token && vol.labels[LABELS.token] !== r.token)) {
        this.event(op, 'purging', `volume ${r.name} is not the one this instance created; left untouched`);
        continue;
      }
      await docker.removeVolume(r.name);
      repo.deleteResource(inst.id, 'volume', r.role);
      this.event(op, 'purging', `deleted volume ${r.name}`);
    }
    const folders = resources.filter((x) => x.kind === 'bind').map((x) => x.name);
    if (folders.length) this.event(op, 'purging', `your folder(s) left untouched: ${folders.join(', ')}`);
    const dir = instanceDir(this.ctx.config.stateDir, inst.id);
    rmSync(dir, { recursive: true, force: true });
    rmSync(path.join(this.ctx.config.stateDir, 'icons', `${inst.id}.bin`), { force: true }); // custom launcher icon, if any
    this.event(op, 'purging', 'deleted secrets, runtime files and the stored release');
    // archived name keeps the row unique while freeing the name for a fresh install
    repo.purgeInstance(inst.id, `${inst.name}~purged~${inst.id.slice(0, 8)}`);
    this.event(op, 'purging', `${inst.name} fully uninstalled; name and ports are free again`);
  }


  // Update: new release, same instance. Containers are recreated from the new release; volumes, folders,
  // secrets, ports and addresses stay. The previous release is kept next to the new one and put back
  // automatically if the new one fails to start or answer, so a bad update leaves the app running as before.
  private async update(op: OperationRow, plan: PlanRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo, config } = this.ctx;
    const u = plan.proposal.update;
    if (!u) throw new HarborError('STATE_CHANGED', 'plan carries no update');
    this.phase(op, 'applying', 'preparing', `loading revision ${u.toRevision} and verifying the installed app`);
    await this.engineOrThrow();
    const next = this.ctx.packages.load(inst.packageId, u.toRevision);
    for (const [f, h] of Object.entries(plan.proposal.releaseHashes)) {
      if (next.hashes[f as keyof typeof next.hashes] !== h) throw new HarborError('STATE_CHANGED', `package ${f} changed since the plan was created`);
    }
    const dirs = this.dirs(inst);
    const previousDir = path.join(dirs.root, 'release-previous');
    const current = loadReleaseSnapshot(dirs.release, inst.packageId);
    const identity = identityFor(this.ctx.installationId, inst.id);
    await this.verifyOwnedVolumes(op, current, identity, inst);
    // keep the old release for rollback (and a record of what ran before)
    rmSync(previousDir, { recursive: true, force: true });
    cpSync(dirs.release, previousDir, { recursive: true });
    this.event(op, 'preparing', `kept revision ${inst.revision} at release-previous for rollback`);
    const before = { revision: inst.revision, releaseHashes: inst.releaseHashes, endpoints: inst.endpoints, desired: inst.desired };

    this.phase(op, 'applying', 'stopping', 'stopping and deleting the current containers (data stays)');
    await this.teardownContainers(op, inst, 'stopping');
    // from here on a failure must roll back
    try {
      this.phase(op, 'applying', 'preparing', `storing revision ${u.toRevision}`);
      for (const f of readdirSync(dirs.release)) rmSync(path.join(dirs.release, f), { force: true, recursive: true });
      writeReleaseSnapshot(dirs.release, next);
      for (const ep of plan.proposal.endpoints) if (!inst.endpoints.some((e) => e.id === ep.id)) repo.claimPort(ep.hostPort, inst.id, ep.id);
      const updated: InstanceRow = { ...inst, revision: next.revision, releaseHashes: next.hashes, endpoints: plan.proposal.endpoints };
      repo.updateInstanceRelease(inst.id, { revision: next.revision, releaseHashes: next.hashes, endpoints: plan.proposal.endpoints });
      repo.updateInstance(inst.id, { installState: 'installing', desired: 'running' });
      // storage: new claims get volumes/folders; existing ones were verified above
      const newClaims = (next.manifest.storage ?? []).filter((c) => !(current.manifest.storage ?? []).some((o) => o.composeVolume === c.composeVolume));
      await this.createOwnedVolumes(op, { ...next, manifest: { ...next.manifest, storage: newClaims } }, identity, updated, plan.proposal.storage);
      // secrets: only the ones this release adds
      const refs = [...inst.secrets];
      for (const sec of next.manifest.secrets ?? []) {
        if (refs.some((r) => r.id === sec.id)) continue;
        generateSecretOnce(dirs.secrets, sec.id, this.ctx.ids);
        refs.push({ id: sec.id, file: path.join('secrets', sec.id) });
        this.event(op, 'preparing', `generated retained secret ${sec.id}`);
      }
      repo.updateInstance(inst.id, { secrets: refs });
      const values = this.readSecrets(next, dirs.secrets, sink);
      const file = await this.renderAndValidate(op, next, identity, updated, dirs.runtime, values);
      const inv = { projectDir: dirs.runtime, projectName: identity.project, file };
      await this.buildImages(op, next, dirs.release);
      if (Object.keys(next.release.images).length) {
        this.phase(op, 'applying', 'pulling', `pulling ${u.images.length || Object.keys(next.release.images).length} image(s) by digest`);
        await this.ctx.compose.pull(inv, config.imagePullTimeoutMs);
      }
      this.phase(op, 'applying', 'starting', `starting ${next.manifest.metadata.name} revision ${next.revision}`);
      repo.updateInstance(inst.id, { runtime: 'starting' });
      const containers = await this.upAndRecord(op, inv, identity, updated);
      await this.checkReadiness(op, next, updated, containers);
      repo.updateInstance(inst.id, { installState: 'installed', everInstalled: true, desired: 'running', runtime: 'running', readiness: 'healthy', observedAt: repo.now() });
      this.event(op, 'checking', `${inst.name} now runs revision ${next.revision}${next.manifest.release.version ? ` (${next.manifest.release.version})` : ''}`);
      this.opResult = { fromRevision: u.fromRevision, toRevision: u.toRevision, rolledBack: false };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.event(op, 'rollback', `update to revision ${u.toRevision} failed: ${reason}; putting revision ${before.revision} back`);
      this.phase(op, 'applying', 'rollback', `restoring revision ${before.revision}`);
      try {
        await this.teardownContainers(op, { ...inst, endpoints: plan.proposal.endpoints }, 'rollback');
        for (const f of readdirSync(dirs.release)) rmSync(path.join(dirs.release, f), { force: true, recursive: true });
        cpSync(previousDir, dirs.release, { recursive: true });
        repo.updateInstanceRelease(inst.id, { revision: before.revision, releaseHashes: before.releaseHashes, endpoints: before.endpoints });
        const restored: InstanceRow = { ...inst, revision: before.revision, releaseHashes: before.releaseHashes, endpoints: before.endpoints };
        const values = this.readSecrets(current, dirs.secrets, sink);
        const file = await this.renderAndValidate(op, current, identity, restored, dirs.runtime, values);
        const inv = { projectDir: dirs.runtime, projectName: identity.project, file };
        // Best effort: the previously built tag still exists on the engine, so a rebuild failure
        // (e.g. the builder is what broke) must not stop the rollback.
        try {
          await this.buildImages(op, current, dirs.release);
        } catch (be) {
          this.event(op, 'rollback', `rebuild of the previous images failed (${be instanceof Error ? be.message : String(be)}); using the images already on the engine`);
        }
        repo.updateInstance(inst.id, { runtime: 'starting' });
        const containers = await this.upAndRecord(op, inv, identity, restored);
        await this.checkReadiness(op, current, restored, containers);
        repo.updateInstance(inst.id, { installState: 'installed', desired: 'running', runtime: 'running', readiness: 'healthy', observedAt: repo.now() });
        this.event(op, 'rollback', `${inst.name} is back on revision ${before.revision}; your data was not changed by Harbor`);
        this.opResult = { fromRevision: u.fromRevision, toRevision: u.toRevision, rolledBack: true };
        throw new HarborError('OPERATION_FAILED', `the update to revision ${u.toRevision} failed (${reason}); ${inst.name} was rolled back to revision ${before.revision} and is running`, { nextAction: 'Check the new release (images, health path); the app keeps running on the previous revision until you try again.' });
      } catch (re) {
        if (re instanceof HarborError && re.code === 'OPERATION_FAILED' && re.message.includes('rolled back')) throw re;
        this.event(op, 'rollback', `rollback failed too: ${re instanceof Error ? re.message : String(re)}`);
        throw new HarborError('OPERATION_FAILED', `the update failed (${reason}) and the rollback did not complete (${re instanceof Error ? re.message : String(re)})`, { nextAction: 'Inspect the app (Details → Technical details). Its data volumes and secrets are intact; Remove then Reinstall restores the last stored release.' });
      }
    } finally {
      // leave the previous release around for one more look when the update succeeded; delete when it rolled back
      if (existsSync(previousDir) && this.opResult?.['rolledBack'] === true) rmSync(previousDir, { recursive: true, force: true });
    }
  }

  // Stop and delete the recorded containers of an instance; keep exposures, network, volumes, secrets, ports.
  private async teardownContainers(op: OperationRow, inst: InstanceRow, phase: string): Promise<void> {
    const { repo, docker } = this.ctx;
    for (const r of repo.resources(inst.id).filter((x) => x.kind === 'container')) {
      const c = await docker.inspectContainer(r.dockerId ?? r.name);
      if (!c) {
        repo.deleteResource(inst.id, 'container', r.role);
        continue;
      }
      if (c.labels[LABELS.instance] !== inst.id) throw new HarborError('OWNERSHIP_CONFLICT', `container ${r.name} is not owned by this instance; refusing to touch it`);
      if (c.state !== 'exited' && c.state !== 'created' && c.state !== 'dead') await docker.stopContainer(c.id, 15);
      await docker.removeContainer(c.id);
      repo.deleteResource(inst.id, 'container', r.role);
      this.event(op, phase, `removed container ${c.name}`);
    }
  }

  private async remove(op: OperationRow, inst: InstanceRow): Promise<void> {
    const { repo, docker } = this.ctx;
    this.phase(op, 'applying', 'removing', 'persisting removal intent (data and secrets are retained)');
    await this.engineOrThrow();
    repo.updateInstance(inst.id, { desired: 'retained' });
    for (const e of repo.exposures(inst.id)) {
      await this.withdrawExposure(op, e);
      repo.deleteExposure(e.id);
      this.event(op, 'removing', `withdrew ${e.via} address ${exposureUrl(e)}`);
    }
    if (inst.primaryExposure !== 'loopback') repo.updateInstance(inst.id, { primaryExposure: 'loopback' });
    const resources = repo.resources(inst.id);
    for (const r of resources.filter((x) => x.kind === 'container')) {
      const c = await docker.inspectContainer(r.dockerId ?? r.name);
      if (!c) {
        this.event(op, 'removing', `container ${r.name} already absent`);
        repo.deleteResource(inst.id, 'container', r.role);
        continue;
      }
      if (c.labels[LABELS.instance] !== inst.id) throw new HarborError('OWNERSHIP_CONFLICT', `container ${r.name} is not owned by this instance; refusing to remove it`);
      if (c.state !== 'exited' && c.state !== 'created' && c.state !== 'dead') await docker.stopContainer(c.id, 15);
      await docker.removeContainer(c.id);
      repo.deleteResource(inst.id, 'container', r.role);
      this.event(op, 'removing', `removed container ${c.name}`);
    }
    const netRec = resources.find((x) => x.kind === 'network');
    if (netRec) {
      const net = await docker.inspectNetwork(netRec.dockerId ?? netRec.name);
      if (!net) {
        repo.deleteResource(inst.id, 'network', netRec.role);
      } else if (net.labels[LABELS.instance] !== inst.id) {
        this.event(op, 'removing', `network ${net.name} is not owned by this instance; left untouched`);
      } else if (net.containerIds.length) {
        this.event(op, 'removing', `network ${net.name} still has ${net.containerIds.length} attached container(s); retained with explanation`);
      } else {
        await docker.removeNetwork(net.id);
        repo.deleteResource(inst.id, 'network', netRec.role);
        this.event(op, 'removing', `removed network ${net.name}`);
      }
    }
    const kept = resources.filter((x) => x.kind === 'volume').map((x) => x.name);
    this.event(op, 'removing', kept.length ? `retained volume(s): ${kept.join(', ')}` : 'no volumes to retain');
    const folders = resources.filter((x) => x.kind === 'bind').map((x) => x.name);
    if (folders.length) this.event(op, 'removing', `your folder(s) untouched: ${folders.join(', ')}`);
    repo.updateInstance(inst.id, { installState: 'retained', desired: 'retained', runtime: 'stopped', readiness: 'unknown', observedAt: repo.now() });
  }
}

export function basicSecretIdFor(endpointId: string): string {
  return `exposure-basic-${endpointId}`;
}
// Desired Caddy routes from state (basic-auth hashes are computed here, so call only when something changed).
export function caddyRoutesFromState(ctx: Ctx, sink: string[]): CaddyRoute[] {
  const routes: CaddyRoute[] = [];
  for (const e of ctx.repo.exposures().filter((x) => x.via === 'public' && x.state !== 'removing')) {
    const inst = ctx.repo.instance(e.instanceId);
    const alloc = inst?.endpoints.find((a) => a.id === e.endpointId);
    if (!inst || !alloc) continue;
    let basicAuth: CaddyRoute['basicAuth'] = null;
    if (e.protection === 'basic') {
      const secretsDir = path.join(ctx.config.stateDir, 'instances', inst.id, 'secrets');
      const raw = readSecret(secretsDir, basicSecretIdFor(e.endpointId));
      sink.push(raw);
      basicAuth = { username: 'harbor', bcryptHash: bcrypt.hashSync(raw, 10) };
    }
    routes.push({ id: e.id, hostname: e.hostname, upstreamPort: alloc.hostPort, basicAuth });
  }
  return routes;
}
// A cheap fingerprint of the desired Caddy state (no hashing): the observer re-applies only when it changes.
export function caddySignature(ctx: Ctx): string {
  const parts = ctx.repo.exposures().filter((x) => x.via === 'public' && x.state !== 'removing').map((e) => `${e.id}:${e.hostname}:${e.port}:${e.protection}`);
  const lan = caddyLanConsole(ctx.config);
  return JSON.stringify({ parts: parts.sort(), lan });
}
export function caddyLanConsole(config: Ctx['config']): CaddyLanConsole | null {
  if (!config.lan.enabled) return null;
  return { hosts: [...lanHostnames(), '*.local', ...machineAddresses().filter((a) => !a.includes(':'))], consolePort: config.listen.port };
}

// ---------- exposure helpers (module scope; used by the class below via prototype extension)

// install: failed (Remove cleans up; never eligible for reinstall unless it once succeeded).
// reinstall: back to retained when nothing was created, so the operator can fix data and retry;
//            failed once containers exist. start/stop/remove: needs_action (inspect, then stop/remove).
// exposure kinds: the app itself is untouched by a failed publish/withdraw, so its install state stays.
function installStateAfterFailure(kind: OperationRow['kind'], hasContainers: boolean, current: InstanceRow['installState']): InstanceRow['installState'] {
  if (kind === 'install') return 'failed';
  if (kind === 'reinstall') return hasContainers ? 'failed' : 'retained';
  if (kind === 'expose' || kind === 'unexpose' || kind === 'reconfigure') return current;
  return 'needs_action';
}

function classify(e: unknown, secrets: string[]): { code: ErrorCode; message: string; nextAction: string; state: 'failed' | 'needs_action' } {
  const redact = (s: string) => secrets.reduce((acc, v) => (v ? acc.split(v).join('[redacted]') : acc), s);
  if (e instanceof HarborError) {
    const needsAction: ErrorCode[] = ['OWNERSHIP_CONFLICT', 'DATA_MISSING', 'SECRET_MISSING', 'STATE_CHANGED'];
    return { code: e.code, message: redact(e.message), nextAction: e.nextAction, state: needsAction.includes(e.code) ? 'needs_action' : 'failed' };
  }
  if (e instanceof ComposeError) {
    const timedOut = e.detail.timedOut;
    return {
      code: 'OPERATION_FAILED',
      message: redact(e.message),
      nextAction: timedOut ? 'The Compose command timed out; inspect the instance and Docker. Resources were kept.' : 'Inspect the operation events and Docker; resources were kept for diagnosis.',
      state: timedOut ? 'needs_action' : 'failed',
    };
  }
  const msg = (e as Error)?.message ?? String(e);
  if (/ENOENT|ECONNREFUSED|socket hang up|EACCES/.test(msg) && /docker|sock/i.test(msg)) {
    return { code: 'DOCKER_UNAVAILABLE', message: redact(msg), nextAction: 'Start Docker Engine and retry.', state: 'failed' };
  }
  return { code: 'INTERNAL', message: redact(msg), nextAction: 'Check the daemon log.', state: 'failed' };
}
