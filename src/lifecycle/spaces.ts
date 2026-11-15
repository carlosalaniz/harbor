import { HarborError } from '../errors.js';
import type { SpaceAddressDto, SpaceDto, SpacesDto } from '../contracts/api.js';
import { checkSpaceName, SHARED_WARNING, spaceAddress, spaceNames, spaceNetworkName, type SpaceDoc } from '../planner/spaces.js';
import type { Ctx } from './context.js';
import { liveInstance, readSpaces, spaceMember, spaceMembers, writeSpaces } from './space-members.js';

// Spaces (decision 202): named groups of apps on Home, optionally on one shared private network. The routes only
// change the desired state (the `spaces` setting); every Docker change runs as a `space` operation per app whose
// network changes (actor space-policy), planned at its turn by the serial queue.

export { SHARED_WARNING };
export const SPACE_POLICY_ACTOR = 'space-policy';


export interface SpaceChange {
  name?: string;
  apps?: string[];
  shared?: boolean;
  confirmShared?: boolean;
}

export class SpacesService {
  constructor(private readonly ctx: Ctx) {}

  list(): SpacesDto {
    return { items: readSpaces(this.ctx).map((s) => this.dto(s)) };
  }

  get(id: string): SpaceDto {
    const s = readSpaces(this.ctx).find((x) => x.id === id);
    if (!s) throw new HarborError('NOT_FOUND', `unknown space ${id}`);
    return this.dto(s);
  }

  create(change: SpaceChange & { name: string }): SpaceDto {
    const before = readSpaces(this.ctx);
    let id = this.ctx.ids.token(4).toString('hex');
    while (before.some((s) => s.id === id)) id = this.ctx.ids.token(4).toString('hex');
    const fresh: SpaceDoc = { id, name: '', shared: false, apps: [] };
    this.commit(before, [...before, fresh], fresh, change);
    return this.get(id);
  }

  update(id: string, change: SpaceChange): SpaceDto {
    const before = readSpaces(this.ctx);
    const cur = before.find((s) => s.id === id);
    if (!cur) throw new HarborError('NOT_FOUND', `unknown space ${id}`);
    this.commit(before, before.map((s) => (s.id === id ? { ...s } : s)), cur, change);
    return this.get(id);
  }

  remove(id: string): SpacesDto {
    const before = readSpaces(this.ctx);
    if (!before.some((s) => s.id === id)) throw new HarborError('NOT_FOUND', `unknown space ${id}`);
    const after = before.filter((s) => s.id !== id);
    writeSpaces(this.ctx, after);
    this.queueChanged(before, after);
    return this.list();
  }

  // Validate and store one space's change (its apps leave any other space), then queue the network changes.
  private commit(before: SpaceDoc[], draft: SpaceDoc[], target: SpaceDoc, change: SpaceChange): void {
    const idx = draft.findIndex((s) => s.id === target.id);
    const next: SpaceDoc = { ...draft[idx]! };
    if (change.name !== undefined) {
      const problem = checkSpaceName(change.name);
      if (problem) throw new HarborError('INVALID_REQUEST', problem);
      next.name = change.name.trim();
      if (draft.some((s) => s.id !== next.id && s.name.toLowerCase() === next.name.toLowerCase())) throw new HarborError('NAME_CONFLICT', `there is already a space called ${next.name}`);
    }
    if (change.apps !== undefined) {
      const apps = [...new Set(change.apps)];
      for (const a of apps) if (!liveInstance(this.ctx, a)) throw new HarborError('NOT_FOUND', `unknown app ${a}`);
      next.apps = apps;
    }
    if (change.shared !== undefined) {
      if (change.shared && !target.shared && !change.confirmShared) throw new HarborError('PERMISSION_REQUIRED', `sharing a network needs your confirmation: ${SHARED_WARNING}`, { nextAction: 'Send the same change with confirmShared: true (CLI: --yes).' });
      next.shared = change.shared;
    }
    if (next.shared) {
      const conflicts = spaceNames(spaceMembers(this.ctx, next)).conflicts;
      if (conflicts.length) throw new HarborError('NAME_CONFLICT', `the apps of ${next.name} cannot share one network: ${conflicts.join('; ')}`, { nextAction: 'Leave one of those apps out of the space, or keep the space without a shared network.' });
    }
    // an app is in at most one space: joining this one takes it out of the others
    const after = draft.map((s, i) => (i === idx ? next : { ...s, apps: s.apps.filter((a) => !next.apps.includes(a)) }));
    writeSpaces(this.ctx, after);
    this.queueChanged(before, after);
  }

  // One `space` operation for each installed app whose shared network changed (none ↔ a space, or another space).
  private queueChanged(before: SpaceDoc[], after: SpaceDoc[]): void {
    const netOf = (docs: SpaceDoc[], id: string) => docs.find((s) => s.shared && s.apps.includes(id))?.id ?? null;
    const ids = new Set([...before, ...after].flatMap((s) => s.apps));
    for (const id of ids) {
      if (netOf(before, id) === netOf(after, id)) continue;
      const inst = liveInstance(this.ctx, id);
      if (!inst || inst.installState !== 'installed') continue; // its next start attaches it
      if (this.ctx.repo.activeOperationsOf(id).some((o) => o.kind === 'space' && o.state === 'queued' && !o.startedAt)) continue; // reads the doc at its turn
      try {
        this.ctx.service.queueAction(id, 'space', SPACE_POLICY_ACTOR, this.ctx.ids.uuid());
      } catch (e) {
        this.ctx.log.warn(`could not queue the space change of ${inst.name}: ${(e as Error).message}`, { instanceId: id });
      }
    }
  }

  private dto(s: SpaceDoc): SpaceDto {
    const members = s.apps.map((id) => liveInstance(this.ctx, id)).filter((i) => i !== null);
    const { names, conflicts } = s.shared ? spaceNames(members.map((i) => spaceMember(this.ctx, i))) : { names: {}, conflicts: [] as string[] };
    return {
      id: s.id,
      name: s.name,
      shared: s.shared,
      network: s.shared ? spaceNetworkName(s.id) : null,
      conflicts,
      apps: members.map((i) => {
        const main = i.endpoints[0]?.service ?? null;
        const addresses: SpaceAddressDto[] = Object.entries(names[i.id] ?? {}).flatMap(([service, aliases]) => {
          const port = i.endpoints.find((e) => e.service === service)?.containerPort ?? null;
          return aliases.map((alias) => ({ alias, service, address: spaceAddress(alias, port), main: alias === i.name && service === main }));
        });
        addresses.sort((a, b) => Number(b.main) - Number(a.main));
        return { instanceId: i.id, name: i.name, addresses };
      }),
    };
  }
}
