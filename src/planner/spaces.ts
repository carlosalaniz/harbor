import { LABELS, PRODUCT } from '../naming.js';

// Spaces (decision 202): pure naming and conflict rules. A space with `shared` on puts every container of its
// apps on one internal network, under only the names Harbor gives (the runner attaches them, never Compose):
// `<app>` for the service of the app's first endpoint, `<app>-<service>` for every service.

export const SPACE_LABEL = `${PRODUCT.labelPrefix}/space`;
export const SPACE_NAME_MAX = 40;
const DNS_LABEL_MAX = 63;

// What sharing costs, said before it is turned on (console, CLI and the API's refusal).
export const SHARED_WARNING = 'Every service of these apps, databases included, can reach every other one. Harbor\'s app login does not apply between them; only each app\'s own login does. Turn it on only for apps you trust with each other\'s data.';

export interface SpaceDoc {
  id: string;
  name: string;
  shared: boolean;
  apps: string[]; // instance ids, in the order they were added
}

export interface SpaceMember {
  instanceId: string;
  name: string; // instance name: [a-z][a-z0-9-]{0,62}
  services: string[]; // the app's own Compose services (Harbor's gate services are never members)
  mainService: string | null; // the service of the app's first endpoint
}

export function spaceNetworkName(spaceId: string): string {
  return `${PRODUCT.projectPrefix}space_${spaceId}`;
}

export function spaceNetworkLabels(installationId: string, spaceId: string): Record<string, string> {
  return { [LABELS.installation]: installationId, [LABELS.kind]: 'space', [SPACE_LABEL]: spaceId };
}

// The names one member's containers answer to on the space network, by service.
export function memberAliases(m: SpaceMember): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const svc of m.services) out[svc] = [...(svc === m.mainService ? [m.name] : []), `${m.name}-${svc}`];
  return out;
}

// Every problem that would make a name on the space network ambiguous or invalid, in plain words. Empty = fine.
export function spaceConflicts(members: readonly SpaceMember[]): string[] {
  const owners = new Map<string, string[]>();
  const problems: string[] = [];
  for (const m of members) {
    for (const [svc, aliases] of Object.entries(memberAliases(m))) {
      for (const a of aliases) {
        owners.set(a, [...new Set([...(owners.get(a) ?? []), m.name])]);
        if (a.length > DNS_LABEL_MAX) problems.push(`the name ${a} is longer than ${DNS_LABEL_MAX} characters`);
        // a service answering to its own service name is harmless (same container); any other one is shadowed
        const shadows = members.filter((o) => o.services.includes(a) && !(o.instanceId === m.instanceId && a === svc)).map((o) => o.name);
        if (shadows.length) problems.push(`the name ${a} (${m.name}) is also a service name inside ${shadows.join(', ')}`);
      }
    }
  }
  for (const [a, who] of owners) if (who.length > 1) problems.push(`${who.join(' and ')} would both answer to ${a}`);
  return [...new Set(problems)];
}

// The names each member really gets: every alias a conflict touches is left out (the others still work), so a
// conflict that appears later (an update that adds a service) never makes a name ambiguous.
export function spaceNames(members: readonly SpaceMember[]): { names: Record<string, Record<string, string[]>>; conflicts: string[] } {
  const conflicts = spaceConflicts(members);
  const counts = new Map<string, number>();
  for (const m of members) for (const aliases of Object.values(memberAliases(m))) for (const a of aliases) counts.set(a, (counts.get(a) ?? 0) + 1);
  const bad = (m: SpaceMember, svc: string, a: string) => (counts.get(a) ?? 0) > 1 || a.length > DNS_LABEL_MAX || members.some((o) => o.services.includes(a) && !(o.instanceId === m.instanceId && a === svc));
  const names: Record<string, Record<string, string[]>> = {};
  for (const m of members) names[m.instanceId] = Object.fromEntries(Object.entries(memberAliases(m)).map(([svc, aliases]) => [svc, aliases.filter((a) => !bad(m, svc, a))]));
  return { names, conflicts };
}

// The address another app of the space uses for one service: a URL when Harbor knows the port of an endpoint the
// service serves, else the bare name.
export function spaceAddress(alias: string, containerPort: number | null): string {
  return containerPort === null ? alias : `http://${alias}:${containerPort}`;
}

// Space ids: 8 lowercase hex characters (part of a Docker network name).
export const SPACE_ID_PATTERN = '^[a-f0-9]{8}$';

// Display names: anything printable, trimmed, 1..40 characters.
export function checkSpaceName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'a space needs a name';
  if (n.length > SPACE_NAME_MAX) return `a space name has at most ${SPACE_NAME_MAX} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) return 'a space name cannot contain control characters';
  return null;
}

// Normalise a stored doc: drop apps that no longer exist and apps listed twice (an app is in at most one space; the
// first space that lists it keeps it).
export function normaliseSpaces(items: readonly SpaceDoc[], exists: (instanceId: string) => boolean): SpaceDoc[] {
  const seen = new Set<string>();
  return items.map((s) => ({
    ...s,
    apps: s.apps.filter((a) => {
      if (!exists(a) || seen.has(a)) return false;
      seen.add(a);
      return true;
    }),
  }));
}
