import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CatalogItemDto, InstanceDetail, InstanceSummary, OperationDto, PlanDto, PlanRequest, SystemDto } from '../contracts/api.js';
import type { LoadedPackage } from '../contracts/types.js';
import { browserUrlFor, managementOrigin } from '../config.js';
import { HarborError } from '../errors.js';
import { listCatalog, loadPackage } from '../packages/catalog.js';
import { identityFor, ownedVolumeName, proposeName } from '../planner/identity.js';
import { allocateEndpoints } from '../planner/ports.js';
import { renderCompose } from '../planner/render.js';
import type { InstanceRow, OperationRow, PlanProposal, PlanRow } from '../state/repo.js';
import { addSeconds, rfc3339 } from '../util.js';
import { ComposeError } from '../docker/adapter.js';
import type { Ctx } from './context.js';
import { instanceSummary, operationDto, planDto } from './dto.js';
import { instanceDir, loadReleaseSnapshot, secretExists } from './instance-dir.js';

export interface SubmitResult {
  operation: OperationRow;
  created: boolean;
}

// Read paths and the plan/submit contract. Mutations of Docker resources live in the runner.
export class ApplicationService {
  private lastDockerObservation: { available: boolean; observedAt: string | null; version: string | null; error: string | null } = { available: false, observedAt: null, version: null, error: null };
  private wake: () => void = () => {};

  constructor(private readonly ctx: Ctx) {}

  onSubmit(wake: () => void): void {
    this.wake = wake;
  }

  recordDockerObservation(o: { available: boolean; version: string | null; error: string | null }): void {
    this.lastDockerObservation = { ...o, observedAt: rfc3339(this.ctx.clock.now()) };
  }

  system(): SystemDto {
    const active = this.ctx.repo.activeOperations().find((o) => o.state !== 'queued') ?? this.ctx.repo.activeOperations()[0];
    return {
      version: this.ctx.version,
      profile: 'local-preview',
      docker: this.lastDockerObservation,
      busyOperationId: active?.id ?? null,
      installationId: this.ctx.installationId,
      managementOrigin: managementOrigin(this.ctx.config),
    };
  }

  catalog(): CatalogItemDto[] {
    return listCatalog(this.ctx.config.catalogDir);
  }

  private packageMeta(i: InstanceRow): { name: string; primaryEndpoint: string; description: string; setup: { endpoint: string; instructions: string } | null } {
    try {
      const pkg = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, i.id), 'release'), i.packageId);
      return { name: pkg.manifest.metadata.name, primaryEndpoint: pkg.manifest.ui.primaryEndpoint, description: pkg.manifest.metadata.description, setup: pkg.manifest.setup ?? null };
    } catch {
      try {
        const pkg = loadPackage(this.ctx.config.catalogDir, i.packageId);
        return { name: pkg.manifest.metadata.name, primaryEndpoint: pkg.manifest.ui.primaryEndpoint, description: pkg.manifest.metadata.description, setup: pkg.manifest.setup ?? null };
      } catch {
        return { name: i.packageId, primaryEndpoint: i.endpoints[0]?.id ?? 'web', description: '', setup: null };
      }
    }
  }

  instances(): InstanceSummary[] {
    return this.ctx.repo.listInstances().map((i) => {
      const meta = this.packageMeta(i);
      return instanceSummary(i, meta.name, meta.primaryEndpoint);
    });
  }

  instanceRow(idOrName: string): InstanceRow {
    const row = this.ctx.repo.instance(idOrName) ?? this.ctx.repo.instanceByName(idOrName);
    if (!row) throw new HarborError('NOT_FOUND', `unknown instance ${idOrName}`);
    return row;
  }

  async instance(id: string): Promise<InstanceDetail> {
    const row = this.instanceRow(id);
    const meta = this.packageMeta(row);
    const summary = instanceSummary(row, meta.name, meta.primaryEndpoint);
    const resources = this.ctx.repo.resources(row.id);
    const presence: (boolean | null)[] = [];
    for (const r of resources) {
      try {
        if (r.kind === 'container') presence.push((await this.ctx.docker.inspectContainer(r.dockerId ?? r.name)) !== null);
        else if (r.kind === 'volume') presence.push((await this.ctx.docker.inspectVolume(r.name)) !== null);
        else presence.push((await this.ctx.docker.inspectNetwork(r.dockerId ?? r.name)) !== null);
      } catch {
        presence.push(null);
      }
    }
    const lastOp = row.lastOperationId ? this.ctx.repo.operation(row.lastOperationId) : null;
    const setupEndpoint = meta.setup ? row.endpoints.find((e) => e.id === meta.setup!.endpoint) : undefined;
    return {
      ...summary,
      description: meta.description,
      setup: meta.setup && setupEndpoint ? { endpointId: setupEndpoint.id, browserUrl: browserUrlFor(setupEndpoint.hostPort), instructions: meta.setup.instructions } : null,
      resources: resources.map((r, i) => ({ kind: r.kind, role: r.role, name: r.name, present: presence[i] ?? null })),
      events: this.ctx.repo.eventsForInstance(row.id, 50).map((e) => ({ cursor: String(e.cursor), at: e.at, phase: e.phase, message: e.message })),
      lastError: lastOp?.errorCode ? { code: lastOp.errorCode, message: lastOp.errorMessage ?? '', nextAction: lastOp.nextAction ?? '' } : null,
    };
  }

  plan(id: string): PlanDto {
    const p = this.ctx.repo.plan(id);
    if (!p) throw new HarborError('NOT_FOUND', `unknown plan ${id}`);
    return this.toPlanDto(p);
  }

  private toPlanDto(p: PlanRow): PlanDto {
    const inst = this.ctx.repo.instance(p.instanceId);
    const storageStates: Record<string, 'new' | 'existing'> = {};
    const secretStates: Record<string, 'new' | 'existing'> = {};
    if (inst && p.kind !== 'install') {
      const resources = this.ctx.repo.resources(inst.id);
      for (const s of p.proposal.storage) storageStates[s.id] = resources.some((r) => r.kind === 'volume' && r.role === s.composeVolume) ? 'existing' : 'new';
      const secretsDir = path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'secrets');
      for (const s of p.proposal.secrets) secretStates[s.id] = secretExists(secretsDir, s.id) ? 'existing' : 'new';
    }
    return planDto(p, storageStates, secretStates);
  }

  operation(id: string): OperationDto {
    const o = this.ctx.repo.operation(id);
    if (!o) throw new HarborError('NOT_FOUND', `unknown operation ${id}`);
    return operationDto(o, this.ctx.repo.eventsForOperation(id, 200));
  }

  // ---- planning

  async createPlan(req: PlanRequest, actor: string): Promise<PlanDto> {
    const { repo, clock, ids, config } = this.ctx;
    const now = clock.now();
    const expiresAt = rfc3339(addSeconds(now, config.planTtlSeconds));
    if (req.kind === 'install') {
      const pkg = loadPackage(config.catalogDir, req.packageId);
      const instances = repo.listInstances();
      const taken = new Set(instances.map((i) => i.name));
      if (!pkg.manifest.deployment.multiInstance && instances.some((i) => i.packageId === pkg.id)) {
        throw new HarborError('NAME_CONFLICT', `${pkg.id} does not support multiple instances`, { nextAction: 'Remove the existing instance first.' });
      }
      const proposed = proposeName(pkg.id, taken, req.name);
      if (proposed.error) throw new HarborError(req.name && taken.has(req.name) ? 'NAME_CONFLICT' : 'INVALID_REQUEST', proposed.error);
      const instanceId = ids.uuid();
      const identity = identityFor(this.ctx.installationId, instanceId);
      const endpoints = await this.allocatePorts(pkg);
      const proposal: PlanProposal = {
        packageId: pkg.id,
        revision: pkg.revision,
        name: proposed.name,
        project: identity.project,
        endpoints,
        storage: (pkg.manifest.storage ?? []).map((s) => ({ id: s.id, composeVolume: s.composeVolume, volumeName: ownedVolumeName(identity, s.composeVolume), purpose: s.purpose })),
        secrets: (pkg.manifest.secrets ?? []).map((s) => ({ id: s.id })),
        changes: [
          `Install ${pkg.manifest.metadata.name} (${pkg.id} revision ${pkg.revision}) as instance "${proposed.name}"`,
          `Create Compose project ${identity.project} with a private bridge network`,
          ...endpoints.map((e) => `Publish endpoint ${e.id}: 127.0.0.1:${e.hostPort} -> ${e.service}:${e.containerPort}`),
          ...(pkg.manifest.storage ?? []).map((s) => `Create retained volume ${ownedVolumeName(identity, s.composeVolume)} (${s.purpose})`),
          ...(pkg.manifest.secrets ?? []).map((s) => `Generate retained secret ${s.id} (${s.bytes} bytes)`),
          ...Object.values(pkg.release.images).map((i) => `Pull image ${i.reference} (${i.tag})`),
        ],
        warnings: [
          ...(pkg.release.qualification.status !== 'passed' ? [`Package qualification is ${pkg.release.qualification.status}`] : []),
          ...(pkg.manifest.setup ? ['This app has its own onboarding after installation; Harbor does not create its accounts.'] : []),
        ],
        releaseHashes: pkg.hashes,
      };
      await this.validateProspective(pkg, identity, endpoints);
      const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'install', instanceId, proposal, expectedGeneration: 0, createdAt: rfc3339(now), expiresAt };
      repo.insertPlan(plan);
      return this.plan(plan.id);
    }

    const inst = this.instanceRow(req.instanceId);
    if (inst.activeOperationId) throw new HarborError('BUSY', `instance ${inst.name} has an active operation`, { operationId: inst.activeOperationId });
    const pkgName = this.packageMeta(inst).name;
    const changes: string[] = [];
    switch (req.kind) {
      case 'start':
        if (inst.installState !== 'installed' && inst.installState !== 'needs_action') throw new HarborError('INVALID_STATE', `cannot start an instance in state ${inst.installState}`);
        if (inst.runtime === 'running' && inst.desired === 'running') throw new HarborError('INVALID_STATE', `instance ${inst.name} is already running`);
        changes.push(`Verify release, retained volumes and secrets of "${inst.name}"`, `Start existing containers of project ${inst.project}`, 'Check readiness');
        break;
      case 'stop':
        if (inst.installState !== 'installed' && inst.installState !== 'needs_action' && inst.installState !== 'failed') throw new HarborError('INVALID_STATE', `cannot stop an instance in state ${inst.installState}`);
        changes.push(`Stop the recorded containers of "${inst.name}" (project ${inst.project})`, 'Keep volumes, secrets and port allocations');
        break;
      case 'remove':
        if (inst.installState === 'retained') throw new HarborError('INVALID_STATE', `instance ${inst.name} is already removed (retained)`);
        changes.push(`Stop and delete the recorded containers of "${inst.name}"`, `Delete the private network ${inst.project}_default if unused`, 'Retain volumes, secrets, name and port allocations');
        break;
      case 'reinstall':
        if (inst.installState !== 'retained') throw new HarborError('INVALID_STATE', `reinstall requires a removed (retained) instance; ${inst.name} is ${inst.installState}`);
        if (!inst.everInstalled) throw new HarborError('INVALID_STATE', `instance ${inst.name} never completed an installation; manual investigation is required`, { nextAction: 'Inspect the instance and its resources manually. Automatic reinstall only applies to previously successful instances.' });
        changes.push(`Reinstall ${pkgName} revision ${inst.revision} into "${inst.name}" using its stored release`, 'Verify retained volumes (ownership tokens) and secrets before starting', `Recreate containers and network for project ${inst.project}`, 'Check readiness');
        break;
    }
    const resources = this.ctx.repo.resources(inst.id);
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: inst.revision,
      name: inst.name,
      project: inst.project,
      endpoints: inst.endpoints,
      storage: resources.filter((r) => r.kind === 'volume').map((r) => ({ id: r.role, composeVolume: r.role, volumeName: r.name, purpose: '' })),
      secrets: inst.secrets.map((s) => ({ id: s.id })),
      changes,
      warnings: req.kind === 'remove' ? ['Data volumes and secrets are retained; nothing is deleted except containers and the private network.'] : [],
      releaseHashes: inst.releaseHashes,
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: req.kind, instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  private async allocatePorts(pkg: LoadedPackage) {
    const { repo, docker, ports, config } = this.ctx;
    const unavailable = new Set<number>([config.listen.port, ...repo.claimedPorts().map((c) => c.port)]);
    try {
      for (const p of await docker.publishedHostPorts()) unavailable.add(p);
    } catch (e) {
      throw new HarborError('DOCKER_UNAVAILABLE', `cannot query Docker port bindings: ${(e as Error).message}`);
    }
    // Lowest candidates first; any port with an actual listener is excluded and allocation retried.
    for (let round = 0; round < 64; round++) {
      const candidates = allocateEndpoints(pkg.manifest, config.appPortRange, unavailable);
      let clean = true;
      for (const c of candidates) {
        if (!(await ports.free(c.hostPort))) {
          unavailable.add(c.hostPort);
          clean = false;
        }
      }
      if (clean) return candidates;
    }
    throw new HarborError('PORT_CONFLICT', 'could not find free loopback ports after repeated attempts');
  }

  // Non-mutating Compose canonical validation of the prospective model, in a scratch directory.
  private async validateProspective(pkg: LoadedPackage, identity: ReturnType<typeof identityFor>, endpoints: PlanProposal['endpoints']): Promise<void> {
    const rendered = renderCompose({ manifest: pkg.manifest, compose: pkg.compose, identity, endpoints, secretValues: null });
    const scratch = path.join(this.ctx.config.stateDir, 'scratch', identity.instanceId);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const file = path.join(scratch, 'compose.yaml');
    try {
      writeFileSync(file, rendered.yaml, { mode: 0o600 });
      await this.ctx.compose.config({ projectDir: scratch, projectName: identity.project, file }, 60_000);
    } catch (e) {
      if (e instanceof ComposeError) throw new HarborError('INVALID_PACKAGE', `Compose rejected the generated model: ${e.message}`);
      throw e;
    } finally {
      if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ---- submission (atomic claims + idempotency)

  submit(planId: string, idempotencyKey: string, actor: string): SubmitResult {
    const { repo, ids } = this.ctx;
    const result = repo.transaction((): SubmitResult => {
      const existing = repo.operationByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.planId === planId && existing.actor === actor) return { operation: existing, created: false };
        throw new HarborError('IDEMPOTENCY_CONFLICT', 'this idempotency key was already used for a different request', { operationId: existing.id });
      }
      const plan = repo.plan(planId);
      if (!plan) throw new HarborError('NOT_FOUND', `unknown plan ${planId}`);
      if (plan.actor !== actor) throw new HarborError('NOT_FOUND', `unknown plan ${planId}`);
      if (plan.consumedOperationId) {
        throw new HarborError('IDEMPOTENCY_CONFLICT', `plan ${planId} was already submitted`, { operationId: plan.consumedOperationId, nextAction: 'Poll the existing operation instead of submitting again.' });
      }
      if (new Date(plan.expiresAt).getTime() <= this.ctx.clock.now().getTime()) throw new HarborError('PLAN_EXPIRED', `plan ${planId} expired at ${plan.expiresAt}`);

      const operationId = ids.uuid();
      if (plan.kind === 'install') {
        if (repo.instanceByName(plan.proposal.name)) throw new HarborError('NAME_CONFLICT', `instance name ${plan.proposal.name} is no longer free`);
        if (repo.instance(plan.instanceId)) throw new HarborError('STATE_CHANGED', 'plan instance already exists');
        const claimed = new Set(repo.claimedPorts().map((c) => c.port));
        for (const e of plan.proposal.endpoints) {
          if (claimed.has(e.hostPort)) throw new HarborError('PORT_CONFLICT', `port ${e.hostPort} was claimed by another operation since planning`);
        }
        repo.insertInstance({
          id: plan.instanceId,
          name: plan.proposal.name,
          project: plan.proposal.project,
          packageId: plan.proposal.packageId,
          revision: plan.proposal.revision,
          generation: 0,
          desired: 'running',
          installState: 'installing',
          runtime: 'unknown',
          readiness: 'unknown',
          everInstalled: false,
          releaseDir: path.join('instances', plan.instanceId, 'release'),
          releaseHashes: plan.proposal.releaseHashes,
          endpoints: plan.proposal.endpoints,
          secrets: [],
          activeOperationId: operationId,
        });
        for (const e of plan.proposal.endpoints) repo.claimPort(e.hostPort, plan.instanceId, e.id);
      } else {
        const inst = repo.instance(plan.instanceId);
        if (!inst) throw new HarborError('NOT_FOUND', `instance ${plan.instanceId} no longer exists`);
        if (inst.generation !== plan.expectedGeneration) throw new HarborError('STATE_CHANGED', `instance ${inst.name} changed since the plan was created (generation ${inst.generation}, expected ${plan.expectedGeneration})`);
        if (inst.activeOperationId) throw new HarborError('BUSY', `instance ${inst.name} has an active operation`, { operationId: inst.activeOperationId });
        repo.updateInstance(inst.id, { activeOperationId: operationId });
      }
      repo.insertOperation({ id: operationId, idempotencyKey, planId, actor, kind: plan.kind, instanceId: plan.instanceId });
      repo.consumePlan(planId, operationId);
      repo.addEvent({ operationId, instanceId: plan.instanceId, phase: 'queued', message: `${plan.kind} accepted for instance ${plan.proposal.name}` });
      return { operation: repo.operation(operationId)!, created: true };
    });
    if (result.created) this.wake();
    return result;
  }
}
