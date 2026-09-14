// Centralized product naming. "Harbor" is a working codename; every user-visible
// name, label prefix, path and API namespace derives from here so a later rename
// touches one file.

export const PRODUCT = {
  codename: 'harbor',
  displayName: 'Harbor',
  cliName: 'harbor',
  profile: 'local-preview',
  apiVersion: 'harbor/v1alpha1',
  labelPrefix: 'io.harbor.preview',
  projectPrefix: 'hb_',
  platformProjectPrefix: 'hb_platform_',
  serviceUser: 'harbor',
  paths: {
    opt: '/opt/harbor',
    etc: '/etc/harbor',
    var: '/var/lib/harbor',
    systemdUnit: 'harbor.service',
  },
  defaults: {
    managementPort: 18000,
    appPortRange: { from: 18080, to: 18999 },
    managementHost: '127.0.0.1',
  },
} as const;

export const LABELS = {
  installation: `${PRODUCT.labelPrefix}/installation`,
  instance: `${PRODUCT.labelPrefix}/instance`,
  token: `${PRODUCT.labelPrefix}/token`,
  kind: `${PRODUCT.labelPrefix}/kind`,
  service: `${PRODUCT.labelPrefix}/service`,
  platformTool: `${PRODUCT.labelPrefix}/platform-tool`,
} as const;

export function projectNameFor(instanceId: string): string {
  return `${PRODUCT.projectPrefix}${instanceId.replace(/-/g, '')}`;
}

export function volumeNameFor(projectName: string, composeVolume: string): string {
  return `${projectName}_${composeVolume}`;
}

export function platformProjectNameFor(toolId: string): string {
  return `${PRODUCT.platformProjectPrefix}${toolId}`;
}
