import path from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { Ctx } from './context.js';
import { HarborError, type ErrorCode } from '../errors.js';
import { ComposeError, type ContainerInfo } from '../docker/adapter.js';
import { LABELS } from '../naming.js';
import { defaultNetworkName, identityFor, ownedVolumeName, volumeLabels, type InstanceIdentity } from '../planner/identity.js';
import { renderCompose, type ConsumerLink, type ProviderLink } from '../planner/render.js';
import { linkAlias, linkNetworkLabels, linkValue } from '../planner/links.js';
import type { NetworkInfo } from '../docker/adapter.js';
import type { LinkRow, PlannedLink } from '../state/repo.js';
import { checkHostDirectory } from '../storage/host-path.js';
import { verifyBindMarker, writeBindMarker } from '../storage/bind-marker.js';
import { createAppHome, unlockAppHome, unwrapMasterKeyForMachine, wrapMasterKeyForMachine, zeroKey, type MachineWrappedKey } from '../storage/app-home.js';
import { protectorFor } from '../storage/crypto-provider.js';
import { zeroMachineKey } from '../auth/machine-key.js';
import type { LoadedPackage } from '../contracts/types.js';
import type { InstanceRow, OperationRow, PlanRow, ResourceRow } from '../state/repo.js';
import { ensureInstanceDirs, generateSecretOnce, instanceDir, loadReleaseSnapshot, readOperatorSecret, readSecret, removeSecret, secretExists, writeOperatorSecret, writeReleaseSnapshot, writeRuntimeCompose } from './instance-dir.js';
import { waitReady } from './readiness.js';
import { appAuthorities, exposureUrl, primaryUrlFor } from '../exposure/urls.js';
import { renderCaddyConfig, type CaddyLanConsole, type CaddyLanHttps, type CaddyRoute } from '../exposure/caddy.js';
import { lanAppHost, lanHostnames, lanNames, machineAddresses } from '../system/lan.js';
import { HTTPS_SETTING, lanHttpsHosts, readTlsState } from '../system/lan-https.js';
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
  // Decision 125: operator-typed secret values handed over with this operation's submission (memory only).
  private supplied: { store: Record<string, string>; clear: string[] } = { store: {}, clear: [] };

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
    // Taken first, whatever happens next: values never outlive their operation.
    this.supplied = this.ctx.service.takeOperatorSecrets(op.planId);
    secretValues.push(...Object.values(this.supplied.store));
    try {
      if (this.stopping) throw new InterruptedError();
      switch (op.kind) {
        case 'install': await this.install(op, plan, inst, secretValues); break;
        case 'reinstall': await this.reinstall(op, plan, inst, secretValues); break;
        case 'start': await this.start(op, plan, inst); break;
        case 'stop': await this.stop(op, inst, plan.actor); break;
        case 'restart': await this.restart(op, inst, secretValues); break;
        case 'remove': await this.remove(op, inst, secretValues); break;
        case 'purge': await this.purge(op, inst, secretValues); break;
        case 'update': await this.update(op, plan, inst, secretValues); break;
        case 'expose': await this.expose(op, plan, inst, secretValues); break;
        case 'unexpose': await this.unexpose(op, plan, inst, secretValues); break;
        case 'reconfigure': await this.reconfigure(op, plan, inst, secretValues); break;
        case 'configure': await this.configure(op, plan, inst, secretValues); break;
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

  // App-home root for an install-location instance: <dir>/<name>/volumes/<claim>.
  // The home itself is created by createAppHome (manifest + vault); the
  // per-claim subdirectories are Harbor-owned (created here, never chowned
  // away) and each managed volume is rooted at its own subdirectory.
  private homeVolumeDir(home: string, composeVolume: string): string {
    return path.join(home, 'volumes', composeVolume);
  }

  private async createOwnedVolumes(op: OperationRow, pkg: LoadedPackage, identity: InstanceIdentity, inst: InstanceRow, planned: PlanRow['proposal']['storage'], homeDir: string | null = null): Promise<void> {
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
        const driveId = writeBindMarker(hostPath, inst.id, claim.id, { required: true });
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
      if (homeDir) {
        // Install-location: the volume lives inside the encrypted app home.
        const device = this.homeVolumeDir(homeDir, claim.composeVolume);
        try {
          mkdirSync(device, { recursive: true, mode: 0o700 });
        } catch (e) {
          throw new HarborError('STATE_UNAVAILABLE', `cannot create app data folder ${device}: ${(e as Error).message}`);
        }
        const created = await docker.createVolume(name, volumeLabels(identity, claim.composeVolume, token), { driverOpts: { type: 'none', o: 'bind', device } });
        repo.upsertResource({ instanceId: inst.id, kind: 'volume', role: claim.composeVolume, dockerId: null, name, token, metadata: { createdAt: created.createdAt, storageId: claim.id, homePath: device } });
        this.event(op, 'preparing', `created retained volume ${name} on the drive (${device})`);
        continue;
      }
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
      // Install-location volumes live on the drive: the home must exist and
      // the backing dir must be there before Docker is touched.
      const homePath = rec.metadata?.['homePath'] as string | undefined;
      if (homePath) {
        const home = repo.resources(inst.id).find((r) => r.kind === 'volume' && r.role === '__home__');
        if (!home) throw new HarborError('DATA_MISSING', `app home for ${inst.name} is not recorded`, { nextAction: 'Re-insert the drive that holds this app, then retry.' });
        try {
          checkHostDirectory(home.name);
        } catch (e) {
          throw new HarborError('DATA_MISSING', `app home ${home.name} is not available: ${e instanceof Error ? e.message : String(e)}`, { nextAction: 'Re-insert the drive that holds this app at the same path, then retry. Harbor will not start the app against a missing drive.' });
        }
      }
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
      if (s.source === 'operator') {
        // Decision 125: the value the operator typed, from the submission; stored exactly like a generated one.
        const v = this.supplied.store[s.id];
        if (v === undefined) {
          if (s.optional) {
            this.event(op, 'preparing', `optional secret ${s.id} was left empty; its variable stays unset`);
            continue;
          }
          throw new HarborError('SECRET_MISSING', `the value you provided for ${s.id} is gone (Harbor restarted after you submitted)`, { nextAction: 'Remove this failed install, then install again and type the value in the review dialog.' });
        }
        writeOperatorSecret(secretsDir, s.id, v, { replace: false });
        if (!refs.some((r) => r.id === s.id)) refs.push({ id: s.id, file: path.join('secrets', s.id) });
        this.event(op, 'preparing', `stored the value you provided for ${s.id} as a retained secret`);
        continue;
      }
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
      if (s.source === 'operator') {
        if (s.optional && !secretExists(secretsDir, s.id)) continue; // left empty: the variable stays unset
        values[s.id] = readOperatorSecret(secretsDir, s.id);
      } else values[s.id] = readSecret(secretsDir, s.id);
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

  // URLs handed to `configuration` bindings follow the instance's primary exposure ("this network" =
  // the secure LAN address when LAN HTTPS is on, else the LAN address in LAN mode; decisions 115/116).
  private endpointUrlsFor(inst: InstanceRow, primary: PrimaryExposure = inst.primaryExposure): Record<string, string> {
    const exposures = this.ctx.repo.exposures(inst.id);
    const lanHost = this.ctx.config.lan.enabled ? lanAppHost() : null;
    const secureHost = lanHost && this.lanHttpsOn() ? lanHost : null;
    return Object.fromEntries(inst.endpoints.map((e) => [e.id, primaryUrlFor(e, exposures, primary, lanHost, secureHost)]));
  }

  private lanHttpsOn(): boolean {
    return this.ctx.config.lan.enabled && (this.ctx.repo.setting<boolean>(HTTPS_SETTING) ?? false);
  }

  // Package `afterStart` hook (decision 116): one command inside the named service with the app's
  // current addresses, so the app's own admin tool (Nextcloud's occ) keeps its trusted hosts in step
  // with LAN / LAN HTTPS / tailnet / public. A failing hook is reported, never fatal: the app runs.
  private async runAfterStartHook(op: OperationRow, pkg: LoadedPackage, inst: InstanceRow, containers?: ContainerInfo[]): Promise<void> {
    const hook = pkg.manifest.hooks?.afterStart;
    if (!hook) return;
    const { repo, docker } = this.ctx;
    const fresh = repo.instance(inst.id) ?? inst;
    const id = containers?.find((c) => c.labels['com.docker.compose.service'] === hook.service)?.id ?? repo.resources(inst.id).find((r) => r.kind === 'container' && r.role === hook.service)?.dockerId ?? null;
    if (!id) {
      this.event(op, 'configuring', `after-start hook skipped: service ${hook.service} has no recorded container`);
      return;
    }
    const exposures = repo.exposures(inst.id);
    const lanHost = this.ctx.config.lan.enabled ? lanAppHost() : null;
    const addresses = appAuthorities(fresh.endpoints, exposures, lanHost ? { names: lanNames(), secure: this.lanHttpsOn() } : null);
    const net = await docker.inspectNetwork(defaultNetworkName(identityFor(this.ctx.installationId, inst.id)));
    const main = fresh.endpoints.find((e) => e.id === pkg.manifest.ui.primaryEndpoint) ?? fresh.endpoints[0];
    const url = main ? primaryUrlFor(main, exposures, fresh.primaryExposure, lanHost, lanHost && this.lanHttpsOn() ? lanHost : null) : '';
    // Harbor's proxies connect from the app network's gateway; your own proxy (decision 118) from its LAN address.
    const proxies = [...new Set([...(net?.gateways ?? []), ...exposures.filter((e) => e.via === 'proxy' && e.proxyFrom).map((e) => e.proxyFrom!)])];
    const env = { HARBOR_ADDRESSES: addresses.join(' '), HARBOR_PROXIES: proxies.join(' '), HARBOR_URL: url };
    this.event(op, 'configuring', `running ${pkg.manifest.metadata.name}'s after-start hook in ${hook.service} (${addresses.length} addresses, main ${url})`);
    try {
      const r = await docker.exec(id, { cmd: hook.command, ...(hook.user ? { user: hook.user } : {}), env, timeoutMs: (hook.timeoutSeconds ?? 120) * 1000 });
      if (r.timedOut) this.event(op, 'configuring', `after-start hook timed out after ${hook.timeoutSeconds ?? 120}s; ${pkg.manifest.metadata.name} runs, but some addresses may not work until the next restart`);
      else if (r.exitCode !== 0) this.event(op, 'configuring', `after-start hook failed (exit ${r.exitCode}): ${r.output.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}; ${pkg.manifest.metadata.name} runs, but some addresses may not work until the next restart`);
      else this.event(op, 'configuring', 'after-start hook finished');
    } catch (e) {
      this.event(op, 'configuring', `after-start hook could not run: ${(e as Error).message}; ${pkg.manifest.metadata.name} runs, but some addresses may not work until the next restart`);
    }
  }

  private async renderAndValidate(op: OperationRow, pkg: LoadedPackage, identity: InstanceIdentity, inst: InstanceRow, runtimeDir: string, secretValues: Record<string, string>, primary?: PrimaryExposure, provisioned?: { username: string; password: string } | null): Promise<string> {
    const externalStorage = Object.fromEntries(this.ctx.repo.resources(inst.id).filter((r) => r.kind === 'bind').map((r) => [r.role, { hostPath: r.name, readOnly: Boolean(r.metadata?.['readOnly']) }]));
    const builtImages = Object.fromEntries(Object.entries(pkg.release.builds ?? {}).map(([svc, b]) => [svc, b.tag]));
    // Decision 126: every active link network must exist before Compose attaches to it (Restart re-applies).
    await this.ensureLinkNetworks(op, inst);
    const { consumerLinks, providerLinks } = this.linkRenderInputs(inst, pkg);
    const rendered = renderCompose({ manifest: pkg.manifest, compose: pkg.compose, identity, endpoints: inst.endpoints, secretValues, endpointUrls: this.endpointUrlsFor(inst, primary), externalStorage, bindHost: this.ctx.config.lan.enabled ? '0.0.0.0' : '127.0.0.1', provisioned: provisioned ?? this.provisionedFor(pkg, inst), builtImages, consumerLinks, providerLinks });
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
    await this.runAfterStartHook(op, pkg, inst, containers);
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
    if (e.via === 'proxy') return; // your proxy's own config is yours to remove
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
    repo.insertExposure({ id: exposureId, instanceId: inst.id, endpointId: x.endpointId, via: x.via, hostname: x.hostname, port: x.port, protection: x.protection, state: 'pending', note: null, proxyFrom: x.proxyFrom ?? null });
    const row = repo.exposure(exposureId)!;
    if (x.via === 'proxy') {
      // Decision 118: the operator's proxy terminates TLS and forwards here; Harbor runs nothing for it.
      this.event(op, 'publishing', `your proxy at ${x.proxyFrom} forwards https://${x.hostname}/ to this machine's port ${alloc.hostPort}`);
    } else if (x.via === 'tailnet') {
      await this.ctx.tailscale.serve(x.port, `http://127.0.0.1:${alloc.hostPort}`);
      this.event(op, 'publishing', `tailscale serve --https=${x.port} -> 127.0.0.1:${alloc.hostPort}`);
    } else {
      await this.reconcileCaddy(op, sink);
    }
    if (x.makePrimary && x.via !== 'proxy') {
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
      repo.updateExposure(exposureId, { state: 'degraded', observedAt: now, note: `not reachable yet: ${last.error ?? `HTTP ${last.status}`}. ${x.via === 'proxy' ? 'Check your proxy forwards this hostname to this machine (from inside your network the domain may not loop back; try it from outside).' : x.via === 'public' ? 'Check the DNS record and that ports 80/443 reach this host; Harbor keeps re-checking.' : 'Check tailnet HTTPS certificates; Harbor keeps re-checking.'}` });
      this.event(op, 'checking', `${url} not reachable yet (${last.error ?? `HTTP ${last.status}`}); exposure recorded as degraded and re-checked periodically`);
    }
    await this.hookAfterAddressChange(op, inst);
    // Credentials appear once, in this operation's result; they are never in DTOs or logs afterwards.
    this.opResult = { exposureId, url, exposureState: last.ok ? 'active' : 'degraded', ...(credentials ? { credentials } : {}) };
  }

  // A new or withdrawn address reaches a running app's hook without a restart (decision 116).
  private async hookAfterAddressChange(op: OperationRow, inst: InstanceRow): Promise<void> {
    const fresh = this.ctx.repo.instance(inst.id);
    if (!fresh || fresh.runtime !== 'running') return;
    const pkg = loadReleaseSnapshot(this.dirs(fresh).release, fresh.packageId);
    if (pkg.manifest.hooks?.afterStart) await this.runAfterStartHook(op, pkg, fresh);
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
    await this.hookAfterAddressChange(op, inst);
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
      await this.hookAfterAddressChange(op, inst);
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

  // ---------- app links (decision 126)

  // Ownership of a link network: this installation, the consumer instance, kind link, this link id.
  private ownsLinkNetwork(net: NetworkInfo, l: LinkRow): boolean {
    return net.labels[LABELS.installation] === this.ctx.installationId && net.labels[LABELS.instance] === l.consumerInstanceId && net.labels[LABELS.kind] === 'link' && net.labels[LABELS.link] === l.linkId;
  }

  // Render inputs: active links where `inst` is the consumer (bound services join, variables get the
  // address) and where it is the provider (its endpoint service joins with the alias).
  private linkRenderInputs(inst: InstanceRow, pkg: LoadedPackage): { consumerLinks: ConsumerLink[]; providerLinks: ProviderLink[] } {
    const { repo } = this.ctx;
    const consumerLinks: ConsumerLink[] = [];
    for (const l of repo.linksOfConsumer(inst.id)) {
      if (l.state !== 'active' || !l.providerInstanceId || !(pkg.manifest.links ?? []).some((c) => c.id === l.linkId)) continue;
      const alloc = repo.instance(l.providerInstanceId)?.endpoints.find((e) => e.id === l.providerEndpoint);
      if (alloc) consumerLinks.push({ id: l.linkId, network: l.networkName, alias: linkAlias(l.linkId), containerPort: alloc.containerPort });
    }
    const providerLinks: ProviderLink[] = [];
    for (const l of repo.linksOfProvider(inst.id)) {
      if (l.state !== 'active') continue;
      const alloc = inst.endpoints.find((e) => e.id === l.providerEndpoint);
      if (alloc) providerLinks.push({ network: l.networkName, service: alloc.service, alias: linkAlias(l.linkId) });
    }
    return { consumerLinks, providerLinks };
  }

  // Create (or verify) the network of one active link. Never adopts a network Harbor did not label.
  private async ensureLinkNetwork(op: OperationRow, l: LinkRow): Promise<NetworkInfo> {
    const { docker, repo } = this.ctx;
    const existing = await docker.inspectNetwork(l.networkName);
    if (existing) {
      if (!this.ownsLinkNetwork(existing, l)) throw new HarborError('OWNERSHIP_CONFLICT', `network ${l.networkName} exists but is not the one Harbor created for link ${l.linkId}`, { nextAction: 'Inspect the network manually (docker network inspect); Harbor never uses or deletes a network it did not create.' });
      if (existing.id !== l.networkId) repo.upsertLink({ ...l, networkId: existing.id });
      return existing;
    }
    const created = await docker.createNetwork(l.networkName, linkNetworkLabels(identityFor(this.ctx.installationId, l.consumerInstanceId), l.linkId, l.providerInstanceId ?? ''), { internal: true });
    repo.upsertLink({ ...l, networkId: created.id });
    this.event(op, 'preparing', `created the private link network ${l.networkName} (internal: no route out, nothing published)`);
    return created;
  }

  private async ensureLinkNetworks(op: OperationRow, inst: InstanceRow): Promise<void> {
    const { repo } = this.ctx;
    for (const l of [...repo.linksOfConsumer(inst.id), ...repo.linksOfProvider(inst.id)]) if (l.state === 'active' && l.providerInstanceId) await this.ensureLinkNetwork(op, l);
  }

  // Containers that sit on a link network: the consumer's bound services, or the provider's endpoint service.
  private linkMembers(l: LinkRow, side: 'consumer' | 'provider'): { id: string; aliases: string[] }[] {
    const { repo } = this.ctx;
    if (side === 'provider') {
      const prov = l.providerInstanceId ? repo.instance(l.providerInstanceId) : null;
      const svc = prov?.endpoints.find((e) => e.id === l.providerEndpoint)?.service;
      if (!prov || !svc) return [];
      return repo.resources(prov.id).filter((r) => r.kind === 'container' && r.role === svc && r.dockerId).map((r) => ({ id: r.dockerId!, aliases: [linkAlias(l.linkId)] }));
    }
    const consumer = repo.instance(l.consumerInstanceId);
    if (!consumer) return [];
    let services: string[] = [];
    try {
      const pkg = loadReleaseSnapshot(this.dirs(consumer).release, consumer.packageId);
      services = (pkg.manifest.links ?? []).find((c) => c.id === l.linkId)?.bindings.map((b) => b.service) ?? [];
    } catch {
      return [];
    }
    return repo.resources(consumer.id).filter((r) => r.kind === 'container' && services.includes(r.role) && r.dockerId).map((r) => ({ id: r.dockerId!, aliases: [] }));
  }

  // After `inst` started: Compose attached its own side; attach the other side live (no restart for it).
  private async attachLinkPeers(op: OperationRow, inst: InstanceRow): Promise<void> {
    const { repo, docker } = this.ctx;
    const work: { l: LinkRow; side: 'consumer' | 'provider' }[] = [
      ...repo.linksOfConsumer(inst.id).map((l) => ({ l, side: 'provider' as const })),
      ...repo.linksOfProvider(inst.id).map((l) => ({ l, side: 'consumer' as const })),
    ];
    for (const { l, side } of work) {
      if (l.state !== 'active' || !l.providerInstanceId) continue;
      const net = await docker.inspectNetwork(l.networkId ?? l.networkName);
      if (!net || !this.ownsLinkNetwork(net, l)) continue;
      for (const m of this.linkMembers(l, side)) {
        if (net.containerIds.includes(m.id)) continue;
        const c = await docker.inspectContainer(m.id);
        if (!c) continue;
        await docker.connectNetwork(net.id, m.id, m.aliases);
        this.event(op, 'starting', `attached ${c.name} to link network ${l.networkName}${m.aliases.length ? ` as ${m.aliases.join(', ')}` : ''}`);
      }
    }
  }

  // Detach everything and delete a link network (ownership verified first). The row is updated by the caller.
  private async dropLinkNetwork(op: OperationRow, l: LinkRow, phase: string): Promise<void> {
    const { docker } = this.ctx;
    const net = (l.networkId ? await docker.inspectNetwork(l.networkId) : null) ?? (await docker.inspectNetwork(l.networkName));
    if (!net) return;
    if (!this.ownsLinkNetwork(net, l)) {
      this.event(op, phase, `network ${net.name} is not the one Harbor created for link ${l.linkId}; left untouched`);
      return;
    }
    for (const cid of net.containerIds) await docker.disconnectNetwork(net.id, cid);
    await docker.removeNetwork(net.id);
    this.event(op, phase, `deleted the private link network ${net.name}`);
  }

  // Re-render another app's Compose file after its links changed (no restart: the live attach/detach
  // already applied it; the file keeps every later `up` consistent).
  private async rewriteCompose(op: OperationRow, other: InstanceRow, sink: string[], bestEffort: boolean): Promise<void> {
    try {
      const fresh = this.ctx.repo.instance(other.id);
      if (!fresh || fresh.purgedAt) return;
      const dirs = this.dirs(fresh);
      if (!existsSync(path.join(dirs.release, 'manifest.yaml'))) return;
      const pkg = loadReleaseSnapshot(dirs.release, fresh.packageId);
      const identity = identityFor(this.ctx.installationId, fresh.id);
      await this.renderAndValidate(op, pkg, identity, fresh, dirs.runtime, this.readSecrets(pkg, dirs.secrets, sink));
      this.event(op, 'preparing', `updated the private Compose file of ${fresh.name} for its links`);
    } catch (e) {
      if (!bestEffort) throw e;
      this.event(op, 'preparing', `could not update the Compose file of ${other.name} (${e instanceof Error ? e.message : String(e)}); its next Restart applies the change`);
    }
  }

  private needsProviderNotice(consumer: InstanceRow, linkId: string, why: string): void {
    this.ctx.notifier.notify({
      kind: 'link-needs-provider',
      severity: 'warning',
      title: `${consumer.name} needs a provider for its link "${linkId}"`,
      body: `${why} Pick another app on its page (Links → Change), or run: harbor configure ${consumer.name} --link ${linkId}=<app>`,
      instanceId: consumer.id,
      dedupeKey: `link-needs-provider:${consumer.id}:${linkId}`,
    });
  }

  // Set up (or clear) the links a plan resolved. Provider side: attached live + its Compose file rewritten.
  private async applyPlannedLinks(op: OperationRow, consumer: InstanceRow, planned: PlannedLink[], sink: string[]): Promise<void> {
    const { repo, docker } = this.ctx;
    for (const p of planned) {
      if (p.change === 'keep') continue;
      const old = repo.link(consumer.id, p.id);
      // a different provider (or unlinking) starts from a clean network
      if (old && old.networkId && (p.change === 'clear' || old.providerInstanceId !== p.provider?.instanceId || old.providerEndpoint !== p.provider?.endpointId)) {
        await this.dropLinkNetwork(op, old, 'preparing');
        const oldProv = old.providerInstanceId ? repo.instance(old.providerInstanceId) : null;
        repo.upsertLink({ ...old, networkId: null, state: 'needs_provider', providerInstanceId: null, providerEndpoint: null, note: null });
        if (oldProv) await this.rewriteCompose(op, oldProv, sink, true);
      }
      if (!p.provider) {
        repo.upsertLink({ consumerInstanceId: consumer.id, linkId: p.id, providerInstanceId: null, providerEndpoint: null, networkName: p.network, networkId: null, state: 'needs_provider', note: p.change === 'clear' ? 'unlinked' : null });
        this.event(op, 'preparing', p.change === 'clear' ? `unlinked ${p.id}` : `optional link ${p.id} has no provider yet`);
        continue;
      }
      const prov = repo.instance(p.provider.instanceId);
      const alloc = prov?.endpoints.find((e) => e.id === p.provider!.endpointId);
      if (!prov || prov.purgedAt || prov.installState !== 'installed' || !alloc) throw new HarborError('STATE_CHANGED', `${p.provider.name}, the provider chosen for link ${p.id}, is no longer installed with endpoint ${p.provider.endpointId}`, { nextAction: 'Create a new plan and pick another provider.' });
      repo.upsertLink({ consumerInstanceId: consumer.id, linkId: p.id, providerInstanceId: prov.id, providerEndpoint: alloc.id, networkName: p.network, networkId: null, state: 'active', note: null });
      const row = repo.link(consumer.id, p.id)!;
      const net = await this.ensureLinkNetwork(op, row);
      for (const m of this.linkMembers(row, 'provider')) {
        if (net.containerIds.includes(m.id) || !(await docker.inspectContainer(m.id))) continue;
        await docker.connectNetwork(net.id, m.id, m.aliases);
      }
      await this.rewriteCompose(op, prov, sink, false);
      this.ctx.notifier.resolve(`link-needs-provider:${consumer.id}:${p.id}`);
      this.event(op, 'preparing', `linked ${p.id}: ${consumer.name} reaches ${prov.name} (${alloc.service}) at ${linkValue(linkAlias(p.id), alloc.containerPort)} on ${p.network}; nothing else joins that network`);
    }
  }

  // Remove/purge of either side drops the link networks (consumer side: dormant, Reinstall brings them back;
  // provider side: the consumer needs a provider). Other apps' Compose files are rewritten, never restarted.
  private async unlinkOnRemove(op: OperationRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo } = this.ctx;
    for (const l of repo.linksOfConsumer(inst.id)) {
      if (l.state !== 'active') continue;
      await this.dropLinkNetwork(op, l, 'removing');
      repo.upsertLink({ ...l, networkId: null, state: 'dormant' });
      const prov = l.providerInstanceId ? repo.instance(l.providerInstanceId) : null;
      if (prov) await this.rewriteCompose(op, prov, sink, true);
    }
    for (const l of repo.linksOfProvider(inst.id)) {
      if (l.state === 'active') await this.dropLinkNetwork(op, l, 'removing');
      repo.upsertLink({ ...l, networkId: null, state: 'needs_provider', providerInstanceId: null, providerEndpoint: null, note: `${inst.name} was removed` });
      const consumer = repo.instance(l.consumerInstanceId);
      if (!consumer) continue;
      if (l.state === 'active') await this.rewriteCompose(op, consumer, sink, true);
      this.event(op, 'removing', `${consumer.name} lost its link ${l.linkId}; it needs a provider now`);
      if (consumer.installState !== 'retained') this.needsProviderNotice(consumer, l.linkId, `${inst.name}, which it reached through this link, was removed.`);
    }
  }

  // Reinstall: dormant links come back when their provider is still installed; otherwise they need one.
  private async revive(op: OperationRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo } = this.ctx;
    for (const l of repo.linksOfConsumer(inst.id)) {
      if (l.state !== 'dormant') continue;
      const prov = l.providerInstanceId ? repo.instance(l.providerInstanceId) : null;
      const alloc = prov?.endpoints.find((e) => e.id === l.providerEndpoint);
      if (prov && alloc && prov.installState === 'installed' && !prov.purgedAt) {
        await this.applyPlannedLinks(op, inst, [{ id: l.linkId, purpose: '', optional: false, provider: { instanceId: prov.id, name: prov.name, endpointId: alloc.id, service: alloc.service, containerPort: alloc.containerPort }, network: l.networkName, alias: linkAlias(l.linkId), change: 'set' }], sink);
      } else {
        repo.upsertLink({ ...l, state: 'needs_provider', providerInstanceId: null, providerEndpoint: null, note: 'its provider is gone' });
        this.needsProviderNotice(inst, l.linkId, 'The app it was linked to is no longer installed.');
      }
    }
  }

  // Links whose id the release no longer declares are removed for good.
  private async pruneLinks(op: OperationRow, inst: InstanceRow, pkg: LoadedPackage, sink: string[]): Promise<void> {
    const { repo } = this.ctx;
    for (const l of repo.linksOfConsumer(inst.id)) {
      if ((pkg.manifest.links ?? []).some((c) => c.id === l.linkId)) continue;
      if (l.state === 'active') await this.dropLinkNetwork(op, l, 'preparing');
      repo.deleteLink(inst.id, l.linkId);
      this.ctx.notifier.resolve(`link-needs-provider:${inst.id}:${l.linkId}`);
      const prov = l.providerInstanceId ? repo.instance(l.providerInstanceId) : null;
      if (prov && l.state === 'active') await this.rewriteCompose(op, prov, sink, true);
      this.event(op, 'preparing', `removed link ${l.linkId} (not part of revision ${pkg.revision})`);
    }
  }

  // A provider's update may drop or move the endpoint a consumer links to.
  private async afterProviderEndpointsChanged(op: OperationRow, inst: InstanceRow, before: InstanceRow['endpoints'], sink: string[]): Promise<void> {
    const { repo } = this.ctx;
    for (const l of repo.linksOfProvider(inst.id)) {
      const consumer = repo.instance(l.consumerInstanceId);
      if (!consumer || l.state !== 'active') continue;
      const now = inst.endpoints.find((e) => e.id === l.providerEndpoint);
      if (!now) {
        await this.dropLinkNetwork(op, l, 'checking');
        repo.upsertLink({ ...l, networkId: null, state: 'needs_provider', providerInstanceId: null, providerEndpoint: null, note: `${inst.name} revision ${inst.revision} has no endpoint ${l.providerEndpoint}` });
        await this.rewriteCompose(op, consumer, sink, true);
        this.needsProviderNotice(consumer, l.linkId, `${inst.name} no longer offers the endpoint it linked to.`);
        continue;
      }
      const was = before.find((e) => e.id === l.providerEndpoint);
      if (was && was.containerPort !== now.containerPort) {
        await this.rewriteCompose(op, consumer, sink, true);
        this.event(op, 'checking', `${inst.name} now answers its link on port ${now.containerPort}; Restart ${consumer.name} to pick up the new address`);
      }
    }
  }

  // Configure (decisions 125/126): new operator-secret values and/or link providers, then re-render + recreate.
  private async configure(op: OperationRow, plan: PlanRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo } = this.ctx;
    this.phase(op, 'applying', 'preparing', `applying new settings to ${inst.name}`);
    await this.engineOrThrow();
    const dirs = this.dirs(inst);
    const pkg = loadReleaseSnapshot(dirs.release, inst.packageId);
    const refs = [...inst.secrets];
    for (const [id, value] of Object.entries(this.supplied.store)) {
      writeOperatorSecret(dirs.secrets, id, value, { replace: true });
      if (!refs.some((r) => r.id === id)) refs.push({ id, file: path.join('secrets', id) });
      this.event(op, 'preparing', `stored the new value of ${id}`);
    }
    for (const id of this.supplied.clear) {
      removeSecret(dirs.secrets, id);
      this.event(op, 'preparing', `cleared the optional secret ${id}; its variable is no longer set`);
    }
    repo.updateInstance(inst.id, { secrets: refs.filter((r) => !this.supplied.clear.includes(r.id)) });
    await this.applyPlannedLinks(op, inst, plan.proposal.links ?? [], sink);
    const identity = identityFor(this.ctx.installationId, inst.id);
    const fresh = repo.instance(inst.id) ?? inst;
    const file = await this.renderAndValidate(op, pkg, identity, fresh, dirs.runtime, this.readSecrets(pkg, dirs.secrets, sink));
    this.phase(op, 'applying', 'starting', 'recreating the containers whose configuration changed (same volumes and ports)');
    repo.updateInstance(inst.id, { runtime: 'starting', desired: 'running' });
    const containers = await this.upAndRecord(op, { projectDir: dirs.runtime, projectName: identity.project, file }, identity, fresh);
    await this.checkReadiness(op, pkg, fresh, containers);
    repo.updateInstance(inst.id, { runtime: 'running', readiness: 'healthy', observedAt: repo.now() });
  }

  // ---------- operations

  private async install(op: OperationRow, plan: PlanRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo, config } = this.ctx;
    this.phase(op, 'applying', 'preparing', 'revalidating package and plan');
    await this.engineOrThrow();
    // Decision 120: refuse before anything is created when a default-key home could not get this
    // machine's wrapping (the daemon restarted between plan and apply, and nobody logged in since).
    if (plan.proposal.location?.defaultKey && !this.ctx.machineKey.unlocked) throw new HarborError('INVALID_STATE', 'Harbor restarted since your last login: log in again before installing an encrypted app', { nextAction: 'Log out and log in with your password once (it unlocks this machine\'s key), then install again.' });
    const pkg = this.ctx.packages.load(inst.packageId, inst.revision);
    for (const [f, h] of Object.entries(plan.proposal.releaseHashes)) {
      if (pkg.hashes[f as keyof typeof pkg.hashes] !== h) throw new HarborError('STATE_CHANGED', `package ${f} changed since the plan was created`);
    }
    const identity = identityFor(this.ctx.installationId, inst.id);
    const dirs = this.dirs(inst);
    writeReleaseSnapshot(dirs.release, pkg);
    this.event(op, 'preparing', `stored release snapshot for ${pkg.id} revision ${pkg.revision}`);
    // Install-location: create the encrypted app home first (manifest +
    // dual-key envelope), seal its volumes dir with fscrypt when the kernel
    // supports it, then root every managed volume inside it. The passphrase
    // arrives with the submission (never in the plan); default-key homes get
    // a machine wrapping so silent unlock works while this machine holds the
    // key. Adopt path: createAppHomeForInstall reuses the pre-recorded home.
    let homeDir: string | null = null;
    if (plan.proposal.location) {
      homeDir = await this.createAppHomeForInstall(op, plan, inst, pkg);
    }
    await this.createOwnedVolumes(op, pkg, identity, inst, plan.proposal.storage, homeDir);
    this.generateSecrets(op, pkg, inst, dirs.secrets);
    await this.applyPlannedLinks(op, inst, plan.proposal.links ?? [], sink);
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
    // Main address chosen at install (decision 116): publish on the tailnet / a domain and make it primary,
    // in the same operation. The provisioned admin login (if any) wins the one `credentials` slot.
    if (plan.proposal.exposure) {
      const prior = this.opResult ?? {};
      await this.expose(op, plan, repo.instance(inst.id) ?? inst, sink);
      this.opResult = { ...prior, ...(this.opResult ?? {}), ...(prior['credentials'] ? { credentials: prior['credentials'] } : {}) };
    }
  }

  // Create the encrypted app home for an install-location install. Returns the
  // home dir. Records a 'home' resource (the home itself) plus, for
  // default-key homes, the machine wrapping of the master key so this machine
  // unlocks silently while AFU. Custom-passphrase homes get no wrapping (they
  // stay locked until Start with the passphrase). Adopt plans skip creation
  // (the home already exists) but still consume the pre-seeded secret so
  // single-use semantics hold for every location plan.
  private async createAppHomeForInstall(op: OperationRow, plan: PlanRow, inst: InstanceRow, pkg: LoadedPackage): Promise<string> {
    const { repo } = this.ctx;
    const loc = plan.proposal.location!;
    // Default-key homes (data folder) carry no passphrase: the secret check
    // is pre-seeded at submit time, so takeInstallLocationSecret returns the
    // 'default-key' marker. Custom-passphrase homes consume the single-use
    // secret like before.
    const passphrase = this.ctx.service.takeInstallLocationSecret(plan.id);
    if (!passphrase) throw new HarborError('STATE_CHANGED', 'the encryption passphrase for this install is gone', { nextAction: 'Create a new plan and submit it with the passphrase.' });
    if (passphrase === 'adopted') {
      const home = repo.resources(inst.id).find((r) => r.kind === 'volume' && r.role === '__home__');
      if (!home) throw new HarborError('STATE_CHANGED', 'adopted app home is not recorded', { nextAction: 'Adopt the app again from Storage.' });
      // A folder from another machine: the record does not know whether it
      // is sealed. Ask root once, then unlock it (or seal a never-sealed one
      // in place) before any volume is rooted inside.
      await this.reconcileAdoptedSeal(op, inst, home);
      await this.ensureKernelUnlocked(op, inst, home);
      return home.name;
    }
    const defaultKey = loc.defaultKey === true || passphrase === 'default-key';
    // Nested layout (decision 97): loc.dir is the package dir
    // (<candidate>/<packageId>); the home itself is <dir>/<instanceName>.
    // createAppHome takes the parent + the home name separately.
    const parentDir = loc.dir;
    const homeName = plan.proposal.name;
    // The Harbor recovery key: one card per installation, stamped onto every
    // home so a single set of words restores all of them. Issued lazily here
    // for installations that predate it, and then shown once in this result.
    const card = this.ctx.service.ensureInstallationRecoveryKey();
    try {
      const { descriptor, masterKey, recoveryKey } = await createAppHome({
        parentDir,
        name: homeName,
        instanceId: inst.id,
        packageId: pkg.id,
        packageRevision: pkg.revision,
        displayName: pkg.manifest.metadata.name,
        ...(defaultKey ? {} : { passphrase }),
        ...(card ? { installationRecoveryKey: card.words } : {}),
        harborVersion: this.ctx.version,
        now: this.ctx.clock.now(),
      });
      try {
        // Machine wrapping for silent unlock: needs AFU (a live machine key).
        // BFU installs cannot happen (submit requires a session, sessions
        // unlock) — but if the key is somehow absent, the install still
        // succeeds; the app just unlocks via passphrase until first login.
        // Custom-passphrase homes (portable drives) deliberately get NO
        // machine wrapping: they stay locked until the operator types the
        // passphrase at Start (per-app lock). Default-key homes wrap so the
        // data folder unlocks silently at login.
        // A custom passphrase that IS the Harbor password gets the same
        // wrapping: it unlocks at login here, and still travels by passphrase.
        const loginKey = !defaultKey && (await this.ctx.service.matchesAdminPassword(passphrase));
        const machineKey = defaultKey || loginKey ? this.ctx.machineKey.take() : null;
        // Decision 120: never seal a default-key home this machine cannot reopen at login (the plan
        // refuses this too; the daemon may have restarted between plan and apply).
        if (defaultKey && !machineKey) throw new HarborError('INVALID_STATE', 'Harbor restarted since your last login: log in again before installing an encrypted app', { nextAction: 'Log out and log in with your password once (it unlocks this machine\'s key), then install again.' });
        let wrapped: MachineWrappedKey | null = null;
        if (machineKey) {
          try {
            wrapped = wrapMasterKeyForMachine(masterKey, machineKey);
          } finally {
            zeroMachineKey(machineKey);
          }
        }
        // Kernel sealing: seal the EMPTY <home>/volumes with fscrypt (v2
        // policy) under the app's own master key, BEFORE any volume is rooted
        // inside. Hard failure: a host that cannot seal fails the install
        // here, the half-made home is deleted so a retry is clean, and the
        // error carries the root step's next action. Harbor never continues
        // with plaintext it would later call "encrypted".
        const crypto = this.ctx.crypto;
        if (crypto) {
          try {
            await crypto.sealApp({ instanceId: inst.id, home: descriptor.home }, masterKey.toString('hex'), protectorFor(plan.proposal.name, inst.id));
          } catch (e) {
            rmSync(descriptor.home, { recursive: true, force: true });
            this.event(op, 'preparing', `could not seal ${descriptor.home}/volumes; removed the unfinished app home`);
            throw e;
          }
          this.event(op, 'preparing', `kernel-sealed ${descriptor.home}/volumes (fscrypt v2, per-app key)`);
        }
        const sealedNote = crypto ? ' (kernel-sealed)' : '';
        repo.upsertResource({ instanceId: inst.id, kind: 'volume', role: '__home__', dockerId: null, name: descriptor.home, token: null, metadata: { home: true, driveId: descriptor.manifest.driveId, kernelSealed: Boolean(crypto), ...(defaultKey ? { defaultKey: true } : {}), ...(wrapped ? { machineWrapped: wrapped } : {}), ...(loginKey && wrapped ? { loginKey: true } : {}) } });
        // A fresh custom install just proved the passphrase: hold the unlock
        // for this boot so Start needs no retyping until reboot/lock.
        if (!defaultKey) {
          this.ctx.service.holdAppUnlock(inst.id, Buffer.from(masterKey));
        }
        // Cards are shown once in the operation result (same UX as
        // provisioned credentials / exposure basic-auth). Never logged, never
        // stored — the operator writes them down or loses the data with them.
        // A custom passphrase earns the app its OWN words; every home is also
        // covered by the Harbor card, which is only ever displayed the once it
        // is issued.
        if (recoveryKey) {
          this.opResult = { ...(this.opResult ?? {}), recoveryKey, recoveryNote: 'Write down these 12 words. They unlock THIS app on any Harbor machine if its passphrase is forgotten. Hand them over with the drive to give someone this one app.' };
        }
        if (card?.minted) {
          this.opResult = { ...(this.opResult ?? {}), installationRecoveryKey: card.words, installationRecoveryNote: 'This is your Harbor recovery key, shown once. Write it down and keep it somewhere safe: it opens every app this Harbor encrypts, on any machine, even if this one dies.' };
        }
        this.event(op, 'preparing', defaultKey
          ? `created encrypted app home ${descriptor.home}${wrapped ? ' (this machine unlocks it silently)' : ' (unlock with your Harbor recovery key until first login)'}${sealedNote}`
          : `created encrypted app home ${descriptor.home} (${loginKey && wrapped ? 'its passphrase is your Harbor password: this machine unlocks it at login' : 'locked with its own passphrase — Start prompts for it'})${sealedNote}`);
        return descriptor.home;
      } finally {
        zeroKey(masterKey);
      }
    } finally {
      // The passphrase is single-use: never linger in memory past apply.
      (passphrase as unknown as { fill?: (v: number) => void }).fill?.(0);
    }
  }

  // Make <home>/volumes readable in the kernel before Docker touches it.
  // Sealed + open: nothing to do (idempotent; survives daemon restarts).
  // Sealed + locked: add the key — the machine key for default-key homes,
  // this boot's held key for custom ones. Never sealed (installed before
  // sealing worked, or adopted from such a machine): seal it in place now —
  // a one-time migration, verified, rolled back on failure. Every failure is
  // HARD: the operation fails with the root step's message and next action.
  // Harbor never starts an app on plaintext it calls encrypted.
  private async ensureKernelUnlocked(op: OperationRow, inst: InstanceRow, homeRow: ResourceRow): Promise<void> {
    const crypto = this.ctx.crypto;
    if (!crypto) return;
    const home = this.ctx.repo.resources(inst.id).find((r) => r.kind === 'volume' && r.role === '__home__') ?? homeRow;
    const defaultKey = home.metadata?.['defaultKey'] === true;
    const sealed = home.metadata?.['kernelSealed'] === true;
    if (sealed && crypto.kernelState(home.name) === 'open') return;
    // Key sources, in order: this boot's held copy (passphrase typed), then
    // the machine wrapping while AFU (default-key homes, and custom homes
    // whose passphrase is the Harbor password).
    let masterKey: Buffer | null = this.ctx.service.takeAppUnlockCopy(inst.id);
    const wrapped = home.metadata?.['machineWrapped'] as MachineWrappedKey | undefined;
    if (!masterKey && wrapped) {
      const machineKey = this.ctx.machineKey.take();
      if (machineKey) {
        try {
          masterKey = unwrapMasterKeyForMachine(wrapped, machineKey);
        } finally {
          zeroMachineKey(machineKey);
        }
      }
    }
    if (!masterKey) {
      throw new HarborError('INVALID_STATE', `${inst.name} is locked`, {
        nextAction: defaultKey
          ? wrapped
            ? 'Log in again to unlock apps on this machine, then Start again.'
            : 'This app has no key on this machine; unlock it with its 12-word recovery key from the app drawer, then Start again.'
          : wrapped
            ? 'Log in again (it unlocks with your Harbor password), or unlock it with its passphrase, then Start again.'
            : 'Unlock it with its encryption passphrase (or recovery key), then Start again.',
      });
    }
    const ref = { instanceId: inst.id, home: home.name };
    try {
      if (!sealed) {
        this.event(op, 'preparing', `sealing existing data at ${home.name}/volumes in place (one-time migration; rolled back on failure)`);
        await crypto.migrateApp(ref, masterKey.toString('hex'), protectorFor(inst.name, inst.id));
        this.ctx.service.markHomeSealed(inst.id);
        this.event(op, 'preparing', `kernel-sealed ${home.name}/volumes (fscrypt v2, per-app key)`);
      } else {
        await crypto.unlockApp(ref, masterKey.toString('hex'));
        this.event(op, 'preparing', `kernel-unlocked ${home.name}/volumes`);
      }
    } finally {
      zeroKey(masterKey);
    }
  }

  // An adopted home carries no record of its seal: ask root (fscrypt
  // status) once and record the answer so the read model and Start agree.
  private async reconcileAdoptedSeal(op: OperationRow, inst: InstanceRow, home: ResourceRow): Promise<void> {
    const crypto = this.ctx.crypto;
    if (!crypto || home.metadata?.['kernelSealed'] !== undefined) return;
    const st = await crypto.statusApp({ instanceId: inst.id, home: home.name });
    this.ctx.service.markHomeSealed(inst.id, st.encrypted);
    this.event(op, 'preparing', st.encrypted ? `adopted home ${home.name} is kernel-sealed` : `adopted home ${home.name} is not sealed yet; it will be sealed in place before the app starts`);
  }

  // `compose up`, then record what exists under our labels. On failure, still record (best effort)
  // so that inspect/remove can see and clean up partially created resources.
  // Restart (decision 116): today's addresses into the Compose file, every container recreated (same
  // volumes, secrets, ports), readiness, then the package's after-start hook (inside checkReadiness).
  private async restart(op: OperationRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo } = this.ctx;
    const dirs = this.dirs(inst);
    const pkg = loadReleaseSnapshot(dirs.release, inst.packageId);
    await this.engineOrThrow();
    this.phase(op, 'applying', 'preparing', `re-rendering ${inst.name} with its current addresses`);
    const identity = identityFor(this.ctx.installationId, inst.id);
    const values = this.readSecrets(pkg, dirs.secrets, sink);
    const file = await this.renderAndValidate(op, pkg, identity, inst, dirs.runtime, values);
    this.phase(op, 'applying', 'starting', 'recreating containers (same volumes, secrets and ports)');
    repo.updateInstance(inst.id, { runtime: 'starting' });
    const containers = await this.upAndRecord(op, { projectDir: dirs.runtime, projectName: identity.project, file }, identity, inst, { forceRecreate: true });
    await this.checkReadiness(op, pkg, inst, containers);
    repo.updateInstance(inst.id, { runtime: 'running', readiness: 'healthy', observedAt: repo.now() });
  }

  private async upAndRecord(op: OperationRow, inv: { projectDir: string; projectName: string; file: string }, identity: InstanceIdentity, inst: InstanceRow, opts: { forceRecreate?: boolean } = {}): Promise<ContainerInfo[]> {
    try {
      await this.ctx.compose.up(inv, this.ctx.config.startTimeoutMs, opts);
    } catch (e) {
      try {
        await this.recordProjectResources(op, identity, inst);
      } catch (re) {
        this.ctx.log.warn(`could not record project resources after failed up: ${(re as Error).message}`, { operationId: op.id });
      }
      throw e;
    }
    const containers = await this.recordProjectResources(op, identity, inst);
    await this.attachLinkPeers(op, inst);
    return containers;
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
    await this.revive(op, inst, sink);
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
    // Custom-passphrase homes must be unlocked for this boot before Docker
    // is touched: consume the single-use Start passphrase (submitted with the
    // operation) or reuse an existing ephemeral unlock. The key is held in
    // memory only — never stored — so a reboot returns the app to locked.
    // The kernel seal (where present) is unlocked with the same key right
    // after, so Docker sees plaintext while the app runs.
    const home = repo.resources(inst.id).find((r) => r.kind === 'volume' && r.role === '__home__');
    if (home) {
      const defaultKey = home.metadata?.['defaultKey'] === true;
      const sealed = home.metadata?.['kernelSealed'] === true;
      const kernelOpen = sealed && this.ctx.crypto ? this.ctx.crypto.kernelState(home.name) === 'open' : false;
      const machineReachable = home.metadata?.['machineWrapped'] !== undefined && this.ctx.machineKey.unlocked;
      if (!defaultKey && !this.ctx.service.isAppUnlocked(inst.id) && !kernelOpen && !machineReachable) {
        const secret = this.ctx.service.takeInstallLocationSecret(_plan.id);
        if (!secret || secret === 'default-key' || secret === 'adopted') {
          throw new HarborError('INVALID_STATE', `${inst.name} is locked`, { nextAction: 'Unlock it with its encryption passphrase (or recovery key), then Start again.' });
        }
        try {
          const masterKey = await unlockAppHome(home.name, secret);
          this.ctx.service.holdAppUnlock(inst.id, masterKey);
          this.event(op, 'preparing', `unlocked ${inst.name} for this boot`);
        } finally {
          (secret as unknown as { fill?: (v: number) => void }).fill?.(0);
        }
      }
      await this.ensureKernelUnlocked(op, inst, home);
    }
    const dirs = this.dirs(inst);
    const pkg = loadReleaseSnapshot(dirs.release, inst.packageId);
    const identity = identityFor(this.ctx.installationId, inst.id);
    await this.verifyOwnedVolumes(op, pkg, identity, inst);
    this.readSecrets(pkg, dirs.secrets, []);
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
    await this.ensureLinkNetworks(op, inst);
    await this.ctx.compose.start({ projectDir: dirs.runtime, projectName: identity.project, file }, config.startTimeoutMs);
    const containers = await this.recordProjectResources(op, identity, inst);
    await this.attachLinkPeers(op, inst);
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
  private async purge(op: OperationRow, inst: InstanceRow, sink: string[]): Promise<void> {
    const { repo, docker } = this.ctx;
    if (inst.installState !== 'retained') await this.remove(op, inst, sink);
    else await this.unlinkOnRemove(op, inst, sink);
    this.phase(op, 'applying', 'purging', 'deleting retained data of this app (verified as Harbor-created first)');
    const resources = repo.resources(inst.id);
    for (const r of resources.filter((x) => x.kind === 'volume')) {
      // The encrypted app home is a folder on disk, not a Docker volume:
      // delete it from the filesystem (ownership is proven by the manifest's
      // instanceId inside, which matches this instance). Docker volumes
      // rooted inside it are removed below via their own records.
      if (r.role === '__home__') {
        try {
          const { describeAppHome } = await import('../storage/app-home.js');
          const { manifest } = describeAppHome(r.name);
          if (manifest.instanceId !== inst.id) {
            this.event(op, 'purging', `app home ${r.name} belongs to another instance; left untouched`);
            continue;
          }
        } catch {
          // Unreadable home: still remove the folder (it is recorded as ours
          // and purge means delete); a missing folder is already gone.
        }
        rmSync(r.name, { recursive: true, force: true });
        repo.deleteResource(inst.id, 'volume', r.role);
        this.event(op, 'purging', `deleted encrypted app home ${r.name}`);
        continue;
      }
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
        if (sec.source === 'operator') {
          const v = this.supplied.store[sec.id];
          if (v === undefined) {
            if (sec.optional) continue;
            throw new HarborError('SECRET_MISSING', `revision ${u.toRevision} needs a value for ${sec.id} and none arrived with the update`, { nextAction: 'Update again and type the value in the review dialog (CLI: --secret).' });
          }
          writeOperatorSecret(dirs.secrets, sec.id, v, { replace: true });
          refs.push({ id: sec.id, file: path.join('secrets', sec.id) });
          this.event(op, 'preparing', `stored the value you provided for the new secret ${sec.id}`);
          continue;
        }
        generateSecretOnce(dirs.secrets, sec.id, this.ctx.ids);
        refs.push({ id: sec.id, file: path.join('secrets', sec.id) });
        this.event(op, 'preparing', `generated retained secret ${sec.id}`);
      }
      // A release that starts provisioning its admin (decision 116: Nextcloud revision 2) gets the
      // retained credential too; an already set-up app ignores it and keeps the account it has.
      const newlyProvisioned = Boolean(next.manifest.provisionedCredentials) && !refs.some((r) => r.id === PROVISIONED_SECRET);
      if (newlyProvisioned) {
        generateSecretOnce(dirs.secrets, PROVISIONED_SECRET, this.ctx.ids);
        refs.push({ id: PROVISIONED_SECRET, file: path.join('secrets', PROVISIONED_SECRET) });
        this.event(op, 'preparing', 'generated the admin credential this release provisions (an app that is already set up keeps its own accounts)');
      }
      repo.updateInstance(inst.id, { secrets: refs });
      // Decision 126: links this release adds get their provider; links it dropped are removed.
      await this.pruneLinks(op, inst, next, sink);
      await this.applyPlannedLinks(op, inst, (plan.proposal.links ?? []).filter((l) => l.change !== 'keep'), sink);
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
      await this.afterProviderEndpointsChanged(op, updated, before.endpoints, sink);
      this.opResult = { fromRevision: u.fromRevision, toRevision: u.toRevision, rolledBack: false };
      // Shown once, like at install: it is the login if the app had not been set up yet.
      if (newlyProvisioned) {
        const pc = this.readProvisioned(next, dirs.secrets, sink);
        if (pc) this.opResult = { ...this.opResult, credentials: pc, credentialsNote: `${next.manifest.provisionedCredentials?.note ?? ''} If you had already set ${next.manifest.metadata.name} up, keep using your own login.`.trim() };
      }
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
        await this.pruneLinks(op, restored, current, sink);
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

  private async remove(op: OperationRow, inst: InstanceRow, sink: string[]): Promise<void> {
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
    await this.unlinkOnRemove(op, inst, sink);
    const netRec = resources.find((x) => x.kind === 'network' && x.role === 'default');
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
  const lanHttps = caddyLanHttps(ctx);
  return JSON.stringify({ parts: parts.sort(), lan, lanHttps });
}
export function caddyLanConsole(config: Ctx['config']): CaddyLanConsole | null {
  if (!config.lan.enabled) return null;
  return { hosts: [...lanHostnames(), '*.local', ...machineAddresses().filter((a) => !a.includes(':'))], consolePort: config.listen.port };
}
// LAN HTTPS served through Caddy (decision 109 + Caddy-owns-443 fix): when LAN HTTPS is on and the Harbor
// cert exists, Caddy terminates TLS for the LAN hostnames (harbor.local, <hostname>.local, the machine's
// addresses) using the Harbor-minted cert and proxies to the management port. The daemon's own 443 listener
// is skipped in this case (Caddy owns 443). Returns null when LAN HTTPS is off or no cert exists yet.
export function caddyLanHttps(ctx: Ctx): CaddyLanHttps | null {
  if (!ctx.config.lan.enabled) return null;
  if (!(ctx.repo.setting<boolean>(HTTPS_SETTING) ?? false)) return null;
  const tls = readTlsState(ctx.config.stateDir);
  if (!tls) return null;
  const hosts = lanHttpsHosts().filter((h) => !h.includes(':'));
  return { hosts, consolePort: ctx.config.listen.port, cert: path.join(ctx.config.stateDir, 'tls', 'server.crt'), key: path.join(ctx.config.stateDir, 'tls', 'server.key') };
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
