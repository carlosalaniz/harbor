import { permissionDto } from '../planner/permissions.js';
import type { EventDto, InstanceSummary, OperationDto, PlanDto } from '../contracts/api.js';
import { browserUrlFor } from '../config.js';
import type { EventRow, ExposureRow, InstanceRow, OperationRow, PlanRow } from '../state/repo.js';
import { endpointUrls, exposureUrl, mainPublicExposure } from '../exposure/urls.js';
import { linkValue } from '../planner/links.js';
import type { ExposureDto } from '../contracts/api.js';

export function eventDto(e: EventRow): EventDto {
  return { cursor: String(e.cursor), at: e.at, phase: e.phase, message: e.message };
}

export function instanceSummary(i: InstanceRow, packageName: string, primaryEndpoint: string, exposures: ExposureRow[] = [], look: { icon: string | null; category: string; login?: InstanceSummary['login']; updateAvailable?: InstanceSummary['updateAvailable']; lanHost?: string | null; lanSecureHost?: string | null; usage?: InstanceSummary['usage']; needsDrive?: InstanceSummary['needsDrive']; home?: InstanceSummary['home']; links?: InstanceSummary['links']; linkedBy?: InstanceSummary['linkedBy']; operatorSecrets?: InstanceSummary['operatorSecrets']; revealableSecrets?: InstanceSummary['revealableSecrets']; settings?: InstanceSummary['settings']; hiddenFromHome?: boolean; apiOnly?: boolean; ports?: InstanceSummary['ports']; version?: string | null; internet?: InstanceSummary['internet']; announce?: InstanceSummary['announce'] } = { icon: null, category: 'other' }): InstanceSummary {
  return {
    id: i.id,
    name: i.name,
    packageId: i.packageId,
    packageName,
    icon: look.icon,
    category: look.category,
    revision: i.revision,
    version: look.version ?? null,
    desired: i.desired,
    installState: i.installState,
    runtime: i.runtime,
    readiness: i.readiness,
    observedAt: i.observedAt,
    endpoints: i.endpoints.map((e) => ({ id: e.id, containerPort: e.containerPort, hostPort: e.hostPort, browserUrl: browserUrlFor(e.hostPort), urls: endpointUrls(e, exposures, look.lanHost ?? null, look.lanSecureHost ? { host: look.lanSecureHost } : null, i.primaryHost), primary: i.primaryExposure })),
    ports: look.ports ?? [],
    primaryEndpoint,
    operationId: i.activeOperationId ?? i.lastOperationId,
    hasRetainedData: i.everInstalled || i.secrets.length > 0,
    updateAvailable: look.updateAvailable ?? null,
    displayName: i.displayName,
    customIcon: i.icon ? (i.icon.kind === 'glyph' ? { kind: 'glyph', glyph: i.icon.glyph, color: i.icon.color } : { kind: 'image', url: `/v1/instances/${i.id}/icon?v=${encodeURIComponent(i.icon.version)}` }) : null,
    usage: look.usage ?? null,
    autoUpdate: i.autoUpdate,
    needsDrive: look.needsDrive ?? null,
    home: look.home ?? null,
    links: look.links ?? [],
    linkedBy: look.linkedBy ?? [],
    operatorSecrets: look.operatorSecrets ?? [],
    revealableSecrets: look.revealableSecrets ?? [],
    ...(look.settings?.length ? { settings: look.settings } : {}),
    hiddenFromHome: look.hiddenFromHome ?? false,
    ...(look.login ? { login: look.login } : {}),
    apiOnly: look.apiOnly ?? false,
    internet: look.internet ?? { mode: 'direct', choice: null, packageDefault: 'direct', allApps: false },
    ...(look.announce?.length ? { announce: look.announce } : {}),
  };
}

export function planDto(p: PlanRow, storageStates: Record<string, 'new' | 'existing'>, secretStates: Record<string, 'new' | 'existing'>, look: { lanHost?: string | null; lanSecureHost?: string | null; onDrive?: boolean } = {}): PlanDto {
  return {
    id: p.id,
    kind: p.kind,
    instanceId: p.instanceId,
    name: p.proposal.name,
    packageId: p.proposal.packageId,
    revision: p.proposal.revision,
    expiresAt: p.expiresAt,
    expectedGeneration: p.expectedGeneration,
    changes: p.proposal.changes,
    // decision 157: the same LAN addresses an installed app gets, so the review matches the install page
    endpoints: p.proposal.endpoints.map((e) => ({ id: e.id, containerPort: e.containerPort, hostPort: e.hostPort, browserUrl: browserUrlFor(e.hostPort), urls: endpointUrls(e, [], look.lanHost ?? null, look.lanSecureHost ? { host: look.lanSecureHost } : null), primary: 'loopback' as const })),
    ports: p.proposal.ports ?? [],
    permissions: (p.proposal.permissions ?? []).map(permissionDto),
    opensPorts: p.proposal.opensPorts ?? [],
    ...(p.proposal.gpu ? { gpu: p.proposal.gpu } : {}),
    storage: p.proposal.storage.map((s) => ({ id: s.id, mode: s.homePath ? ('home' as const) : s.hostPath ? ('external' as const) : ('managed' as const), volumeName: s.homePath ?? (s.hostPath ? null : s.volumeName), hostPath: s.hostPath ?? null, readOnly: s.readOnly ?? false, purpose: s.purpose, state: storageStates[s.id] ?? 'new' })),
    location: p.proposal.location ? { dir: p.proposal.location.dir, encrypted: true as const, onDrive: look.onDrive ?? false, defaultKey: p.proposal.location.defaultKey ?? false } : null,
    secrets: p.proposal.secrets.map((s) => ({ id: s.id, state: secretStates[s.id] ?? 'new', source: s.source === 'operator' ? ('operator' as const) : ('generated' as const), prompt: s.prompt ?? null, optional: s.optional ?? false, minLength: s.minLength ?? null, maxLength: s.maxLength ?? null, ask: s.ask ?? null })),
    links: (p.proposal.links ?? []).map((l) => ({ id: l.id, purpose: l.purpose, optional: l.optional, provider: l.provider ? { instanceId: l.provider.instanceId, name: l.provider.name, endpointId: l.provider.endpointId, url: linkValue(l.alias, l.provider.containerPort) } : null, alias: l.alias, network: l.network, change: l.change ?? 'set' })),
    ...(p.proposal.settings?.length ? { settings: p.proposal.settings } : {}),
    ...(p.proposal.internet ? { internet: p.proposal.internet } : {}),
    warnings: p.proposal.warnings,
    notes: p.proposal.notes ?? [],
    ...(p.proposal.update ? { update: p.proposal.update } : {}),
    ...(p.proposal.exposure
      ? { exposure: { endpointId: p.proposal.exposure.endpointId, via: p.proposal.exposure.via, url: exposureUrl(p.proposal.exposure), protection: p.proposal.exposure.protection, makePrimary: p.proposal.exposure.makePrimary } }
      : {}),
  };
}

// isPrimary: this row is the instance's main address. With several public hostnames only the main one
// (primaryHost, else the first published) is (decision 127). `siblings` = the instance's exposures.
export function exposureDto(e: ExposureRow, instanceName: string, primary: InstanceRow['primaryExposure'], primaryHost: string | null = null, siblings: ExposureRow[] = [e]): ExposureDto {
  const isPrimary = primary === e.via && (e.via !== 'public' || mainPublicExposure(siblings, e.endpointId, primaryHost)?.id === e.id);
  return { id: e.id, instanceId: e.instanceId, instanceName, endpointId: e.endpointId, via: e.via, url: exposureUrl(e), hostname: e.hostname, port: e.port, protection: e.protection, state: e.state, observedAt: e.observedAt, note: e.note, isPrimary };
}

// Decision 183: operations Harbor queued to protect something; a person cannot cancel them.
export const PROTECTED_ACTORS: ReadonlyMap<string, string> = new Map([
  ['drive-guard', 'Harbor queued it because a drive went away or came back'],
  ['link-guard', 'Harbor queued it to keep the app links safe'],
  ['lock-guard', 'Harbor queued it because the app\'s key is back'],
  ['scheduler', 'it is the cold pass of a backup run'],
]);
// Why a person may not cancel this actor's item, or null (a Map: a login name like 'constructor' is not a protected actor).
export function protectedReason(actor: string): string | null {
  return PROTECTED_ACTORS.get(actor) ?? null;
}

// The app's display name; a freed row (cancelled install, full uninstall) keeps only its archived name `<name>~…`.
export function operationInstanceName(inst: InstanceRow | null, fallback: string): string {
  if (!inst) return fallback;
  if (inst.purgedAt) return inst.name.split('~')[0] ?? inst.name;
  return inst.displayName ?? inst.name;
}

export function isCancellable(o: OperationRow): boolean {
  return o.state === 'queued' && o.startedAt === null && protectedReason(o.actor) === null;
}

export function operationDto(o: OperationRow, events: EventRow[], instanceName = ''): OperationDto {
  return {
    id: o.id,
    kind: o.kind,
    instanceId: o.instanceId,
    instanceName,
    planId: o.planId,
    actor: o.actor,
    queuedAction: o.planId === null && o.state === 'queued',
    cancellable: isCancellable(o),
    state: o.state,
    phase: o.phase,
    createdAt: o.createdAt,
    startedAt: o.startedAt,
    finishedAt: o.finishedAt,
    error: o.errorCode ? { code: o.errorCode, message: o.errorMessage ?? '', nextAction: o.nextAction ?? '' } : null,
    result: o.result,
    events: events.map(eventDto),
  };
}
