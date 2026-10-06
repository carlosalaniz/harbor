import type { LinkFormat } from '../contracts/types.js';
import { LABELS } from '../naming.js';
import { instanceLabels, type InstanceIdentity } from './identity.js';

// App links (decision 126): pure naming and value rules. One Docker network per (consumer, link id),
// owned by the consumer instance and labelled like every Harbor resource; only the consumer's bound
// services and the provider's endpoint service join it. The provider answers on it as `<id>-link`.

export function linkAlias(linkId: string): string {
  return `${linkId}-link`;
}

export function linkNetworkName(consumer: InstanceIdentity, linkId: string): string {
  return `${consumer.project}_link_${linkId}`;
}

export function linkNetworkLabels(consumer: InstanceIdentity, linkId: string, providerInstanceId: string): Record<string, string> {
  return instanceLabels(consumer, { [LABELS.kind]: 'link', [LABELS.link]: linkId, [LABELS.provider]: providerInstanceId });
}

// What a consumer's variable receives. `url` has no trailing slash: base URLs get paths appended.
export function linkValue(alias: string, containerPort: number, format: LinkFormat = 'url'): string {
  switch (format) {
    case 'url':
      return `http://${alias}:${containerPort}`;
    case 'authority':
      return `${alias}:${containerPort}`;
    case 'host':
      return alias;
    case 'port':
      return String(containerPort);
  }
}
