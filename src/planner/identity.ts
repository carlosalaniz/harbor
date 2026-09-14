import { LABELS, projectNameFor, volumeNameFor } from '../naming.js';
import { ID_RE } from '../contracts/patterns.js';

export interface InstanceIdentity {
  installationId: string;
  instanceId: string;
  project: string;
}

export function identityFor(installationId: string, instanceId: string): InstanceIdentity {
  return { installationId, instanceId, project: projectNameFor(instanceId) };
}

export function instanceLabels(id: InstanceIdentity, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [LABELS.installation]: id.installationId,
    [LABELS.instance]: id.instanceId,
    ...extra,
  };
}

export function volumeLabels(id: InstanceIdentity, composeVolume: string, token: string): Record<string, string> {
  return instanceLabels(id, { [LABELS.kind]: 'volume', [LABELS.token]: token, [LABELS.service]: composeVolume });
}

export function ownedVolumeName(id: InstanceIdentity, composeVolume: string): string {
  return volumeNameFor(id.project, composeVolume);
}

export function defaultNetworkName(id: InstanceIdentity): string {
  return `${id.project}_default`;
}

// Default instance names: package id if free, else <package>-2, <package>-3, ...
export function proposeName(packageId: string, taken: Set<string>, requested?: string): { name: string; error?: string } {
  if (requested !== undefined) {
    if (!ID_RE.test(requested)) return { name: requested, error: `name must match [a-z][a-z0-9-]{0,62}` };
    if (taken.has(requested)) return { name: requested, error: `name ${requested} is already used by another instance` };
    return { name: requested };
  }
  if (!taken.has(packageId)) return { name: packageId };
  for (let n = 2; n < 1000; n++) {
    const candidate = `${packageId}-${n}`;
    if (!taken.has(candidate)) return { name: candidate };
  }
  return { name: packageId, error: 'no free default name' };
}
