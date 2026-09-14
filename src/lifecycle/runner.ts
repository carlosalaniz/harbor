import path from 'node:path';
import type { Ctx } from './context.js';
import { HarborError, type ErrorCode } from '../errors.js';
import { ComposeError, type ContainerInfo } from '../docker/adapter.js';
import { LABELS } from '../naming.js';
import { defaultNetworkName, identityFor, ownedVolumeName, volumeLabels, type InstanceIdentity } from '../planner/identity.js';
import { renderCompose } from '../planner/render.js';
import { loadPackage } from '../packages/catalog.js';
import type { LoadedPackage } from '../contracts/types.js';
import type { InstanceRow, OperationRow, PlanRow } from '../state/repo.js';
import { ensureInstanceDirs, generateSecretOnce, loadReleaseSnapshot, readSecret, writeReleaseSnapshot, writeRuntimeCompose } from './instance-dir.js';
import { waitReady } from './readiness.js';

// One mutation at a time. Phase intent is persisted before side effects; created IDs after.
export class OperationRunner {
  private running = false;
  private stopping = false;
  private idle: Promise<void> = Promise.resolve();

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
    try {
      switch (op.kind) {
        case 'install': await this.install(op, plan, inst, secretValues); break;
        case 'reinstall': await this.reinstall(op, plan, inst, secretValues); break;
        case 'start': await this.start(op, plan, inst); break;
        case 'stop': await this.stop(op, inst); break;
        case 'remove': await this.remove(op, inst); break;
      }
      repo.transaction(() => {
        repo.finishOperation(op.id, 'succeeded', { result: { instanceId: inst.id, name: inst.name } });
        repo.updateInstance(inst.id, { activeOperationId: null, lastOperationId: op.id });
        repo.bumpGeneration(inst.id);
        repo.addEvent({ operationId: op.id, instanceId: inst.id, phase: 'succeeded', message: `${op.kind} succeeded` });
      });
    } catch (e) {
      const { code, message, nextAction, state } = classify(e, secretValues);
      this.ctx.log.warn(`${op.kind} ${state}: ${message}`, { operationId: op.id, instanceId: inst.id, code });
      repo.transaction(() => {
        repo.finishOperation(op.id, state, { errorCode: code, errorMessage: message, nextAction });
        const failedInstall = op.kind === 'install' || op.kind === 'reinstall';
        repo.updateInstance(inst.id, {
          activeOperationId: null,
          lastOperationId: op.id,
          installState: state === 'needs_action' ? 'needs_action' : failedInstall ? 'failed' : 'needs_action',
          readiness: 'unknown',
        });
        repo.bumpGeneration(inst.id);
        repo.addEvent({ operationId: op.id, instanceId: inst.id, phase: state, message: `${op.kind} ${state}: ${message}` });
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

  private async createOwnedVolumes(op: OperationRow, pkg: LoadedPackage, identity: InstanceIdentity, inst: InstanceRow): Promise<void> {
    const { docker, repo, ids } = this.ctx;
    for (const claim of pkg.manifest.storage ?? []) {
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
    const resources = repo.resources(inst.id).filter((r) => r.kind === 'volume');
    for (const claim of pkg.manifest.storage ?? []) {
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

  private async renderAndValidate(op: OperationRow, pkg: LoadedPackage, identity: InstanceIdentity, inst: InstanceRow, runtimeDir: string, secretValues: Record<string, string>): Promise<string> {
    const rendered = renderCompose({ manifest: pkg.manifest, compose: pkg.compose, identity, endpoints: inst.endpoints, secretValues });
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
    const bound = container.ports.some((p) => p.hostIp === '127.0.0.1' && p.hostPort === alloc.hostPort && p.containerPort === alloc.containerPort);
    if (!bound) throw new HarborError('OPERATION_FAILED', `container ${container.name} does not publish 127.0.0.1:${alloc.hostPort}->${alloc.containerPort}; refusing to probe an unrelated listener`);
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
    );
    if (!result.ok) {
      repo.updateInstance(inst.id, { readiness: 'unhealthy', observedAt: repo.now() });
      throw new HarborError('READINESS_TIMEOUT', `readiness check did not pass within ${health.deadlineSeconds}s (last: ${result.last.status ?? result.last.error}); containers were kept for inspection`);
    }
    this.event(op, 'checking', `readiness passed after ${result.attempts} attempt(s) with status ${result.last.status}`);
  }

  // ---------- operations

  private async install(op: OperationRow, plan: PlanRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo, config } = this.ctx;
    this.phase(op, 'applying', 'preparing', 'revalidating package and plan');
    await this.engineOrThrow();
    const pkg = loadPackage(config.catalogDir, inst.packageId, inst.revision);
    for (const [f, h] of Object.entries(plan.proposal.releaseHashes)) {
      if (pkg.hashes[f as keyof typeof pkg.hashes] !== h) throw new HarborError('STATE_CHANGED', `bundled package ${f} changed since the plan was created`);
    }
    const identity = identityFor(this.ctx.installationId, inst.id);
    const dirs = this.dirs(inst);
    writeReleaseSnapshot(dirs.release, pkg);
    this.event(op, 'preparing', `stored release snapshot for ${pkg.id} revision ${pkg.revision}`);
    await this.createOwnedVolumes(op, pkg, identity, inst);
    this.generateSecrets(op, pkg, inst, dirs.secrets);
    const values = this.readSecrets(pkg, dirs.secrets, sink);
    const file = await this.renderAndValidate(op, pkg, identity, inst, dirs.runtime, values);
    const inv = { projectDir: dirs.runtime, projectName: identity.project, file };

    this.phase(op, 'applying', 'pulling', `pulling ${Object.keys(pkg.release.images).length} image(s) by digest`);
    await this.ctx.compose.pull(inv, config.imagePullTimeoutMs);

    this.phase(op, 'applying', 'starting', 'creating and starting the Compose project');
    repo.updateInstance(inst.id, { runtime: 'starting' });
    const containers = await this.upAndRecord(op, inv, identity, inst);
    await this.checkReadiness(op, pkg, inst, containers);
    repo.updateInstance(inst.id, { installState: 'installed', everInstalled: true, desired: 'running', runtime: 'running', readiness: 'healthy', observedAt: repo.now() });
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

    this.phase(op, 'applying', 'pulling', 'pulling exact stored images');
    await this.ctx.compose.pull(inv, config.imagePullTimeoutMs);
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

  private async stop(op: OperationRow, inst: InstanceRow): Promise<void> {
    const { repo, docker } = this.ctx;
    this.phase(op, 'applying', 'stopping', 'persisting desired state stopped');
    await this.engineOrThrow();
    repo.updateInstance(inst.id, { desired: 'stopped' });
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

  private async remove(op: OperationRow, inst: InstanceRow): Promise<void> {
    const { repo, docker } = this.ctx;
    this.phase(op, 'applying', 'removing', 'persisting removal intent (data and secrets are retained)');
    await this.engineOrThrow();
    repo.updateInstance(inst.id, { desired: 'retained' });
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
    repo.updateInstance(inst.id, { installState: 'retained', desired: 'retained', runtime: 'stopped', readiness: 'unknown', observedAt: repo.now() });
  }
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
