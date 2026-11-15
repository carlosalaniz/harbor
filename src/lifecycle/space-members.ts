import path from 'node:path';
import type { NetworkInfo } from '../docker/adapter.js';
import { LABELS } from '../naming.js';
import { normaliseSpaces, SPACE_LABEL, spaceNames, type SpaceDoc, type SpaceMember } from '../planner/spaces.js';
import { gateService } from '../planner/gate.js';
import type { InstanceRow } from '../state/repo.js';
import type { Ctx } from './context.js';
import { instanceDir, loadReleaseSnapshot } from './instance-dir.js';

// Spaces (decision 202): the stored doc and who is in which space. Shared by the spaces service (the API), the runner
// (which attaches containers) and the DTO mapping.

export const SPACES_SETTING = 'spaces';

export function liveInstance(ctx: Pick<Ctx, 'repo'>, id: string): InstanceRow | null {
  const inst = ctx.repo.instance(id);
  return inst && !inst.purgedAt ? inst : null;
}

export function readSpaces(ctx: Pick<Ctx, 'repo'>): SpaceDoc[] {
  const doc = ctx.repo.setting<{ items?: SpaceDoc[] }>(SPACES_SETTING);
  return normaliseSpaces(doc?.items ?? [], (id) => liveInstance(ctx, id) !== null);
}

export function writeSpaces(ctx: Pick<Ctx, 'repo'>, items: SpaceDoc[]): void {
  ctx.repo.setSetting(SPACES_SETTING, { items });
}

export function spaceOfInstance(ctx: Pick<Ctx, 'repo'>, instanceId: string): SpaceDoc | null {
  return readSpaces(ctx).find((s) => s.apps.includes(instanceId)) ?? null;
}

// Gate containers (decision 194) never join: peers reach the service itself.
export function isGateService(service: string): boolean {
  return service.startsWith(gateService(''));
}

// What a member brings to the space: its own services from the installed release, and its first endpoint's service.
export function spaceMember(ctx: Pick<Ctx, 'config'>, inst: InstanceRow): SpaceMember {
  let services: string[];
  try {
    const pkg = loadReleaseSnapshot(path.join(instanceDir(ctx.config.stateDir, inst.id), 'release'), inst.packageId);
    services = Object.keys(pkg.compose.services).filter((s) => !isGateService(s));
  } catch {
    services = [...new Set(inst.endpoints.map((e) => e.service))];
  }
  return { instanceId: inst.id, name: inst.name, services, mainService: inst.endpoints[0]?.service ?? null };
}

export function spaceMembers(ctx: Pick<Ctx, 'repo' | 'config'>, space: SpaceDoc): SpaceMember[] {
  return space.apps.map((id) => liveInstance(ctx, id)).filter((i): i is InstanceRow => i !== null).map((i) => spaceMember(ctx, i));
}

// The names each member gets on the shared network (conflicting ones left out) and the conflicts.
export function spaceNamesOf(ctx: Pick<Ctx, 'repo' | 'config'>, space: SpaceDoc): ReturnType<typeof spaceNames> {
  return spaceNames(spaceMembers(ctx, space));
}

// Ownership of a space network: this installation, kind space, this space id.
export function ownsSpaceNetwork(ctx: Pick<Ctx, 'installationId'>, net: NetworkInfo, spaceId?: string): boolean {
  return net.labels[LABELS.installation] === ctx.installationId && net.labels[LABELS.kind] === 'space' && Boolean(net.labels[SPACE_LABEL]) && (spaceId === undefined || net.labels[SPACE_LABEL] === spaceId);
}
