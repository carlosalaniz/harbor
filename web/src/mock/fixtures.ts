import type {
  AppearanceDto,
  CatalogItemDto,
  DomainsDto,
  EndpointDto,
  ExposureDto,
  HostStorageDto,
  InstanceSummary,
  NotificationChannelDto,
  NotificationsDto,
  PlatformToolDto,
  PrimaryExposure,
  StorageUsageDto,
  SystemDto,
  SystemHostDto,
  SystemMetricsDto,
  UiExposureDto,
} from '../../../src/contracts/api';

const now = () => new Date().toISOString();
const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

// Rich enough to exercise every view: healthy/failed/stopped/retained apps, an update,
// notifications, exposures, tools, storage, domains. Nothing here touches a real machine.
export function mockCatalog(): CatalogItemDto[] {
  const app = (id: string, name: string, description: string, extra?: Partial<CatalogItemDto>): CatalogItemDto => ({
    id,
    name,
    description,
    revision: '1',
    version: '1.0',
    origin: 'bundled',
    availability: 'available',
    reason: null,
    qualification: 'passed',
    presentation: {
      tagline: description,
      category: 'productivity',
      icon: null,
      gallery: [],
      developer: 'Mock developer',
      website: null,
      releaseNotes: null,
      hasWidget: false,
    },
    defaultCredentials: null,
    setup: false,
    storage: 0,
    claims: [],
    ...extra,
  });
  return [
    app('nextcloud', 'Nextcloud', 'Files, calendar and contacts on your machine'),
    app('immich', 'Immich', 'Photo backup and timeline', {
      claims: [{ id: 'library', purpose: 'Photo library', external: { hint: '/photos', required: false, readOnly: false } }],
      presentation: {
        tagline: 'Photo backup and timeline',
        category: 'media',
        icon: null,
        gallery: [],
        developer: 'Mock developer',
        website: null,
        releaseNotes: null,
        hasWidget: true,
      },
    }),
    app('jellyfin', 'Jellyfin', 'Movies and shows, streamed at home', {
      presentation: {
        tagline: 'Movies and shows, streamed at home',
        category: 'media',
        icon: null,
        gallery: [],
        developer: 'Mock developer',
        website: null,
        releaseNotes: null,
        hasWidget: false,
      },
    }),
    app('vaultwarden', 'Vaultwarden', 'Password manager for the whole family', {
      presentation: {
        tagline: 'Password manager for the whole family',
        category: 'security',
        icon: null,
        gallery: [],
        developer: 'Mock developer',
        website: null,
        releaseNotes: null,
        hasWidget: false,
      },
    }),
    app('n8n', 'n8n', 'Automate the boring parts of your week', {
      presentation: {
        tagline: 'Automate the boring parts of your week',
        category: 'automation',
        icon: null,
        gallery: [],
        developer: 'Mock developer',
        website: null,
        releaseNotes: null,
        hasWidget: false,
      },
    }),
    app('memos', 'Memos', 'Quick notes that stay yours', {
      presentation: {
        tagline: 'Quick notes that stay yours',
        category: 'productivity',
        icon: null,
        gallery: [],
        developer: 'Mock developer',
        website: null,
        releaseNotes: null,
        hasWidget: false,
      },
    }),
    app('excalidraw', 'Excalidraw', 'Whiteboard for quick sketches and diagrams'),
    app('open-webui', 'Open WebUI', 'Chat with models running on your machine', {
      presentation: {
        tagline: 'Chat with models running on your machine',
        category: 'ai',
        icon: null,
        gallery: [],
        developer: 'Mock developer',
        website: null,
        releaseNotes: null,
        hasWidget: false,
      },
    }),
  ];
}

function endpoint(hostPort: number, primary: PrimaryExposure = 'loopback'): EndpointDto {
  return {
    id: 'web',
    containerPort: 80,
    hostPort,
    browserUrl: `http://localhost:${hostPort}`,
    urls: { loopback: `http://localhost:${hostPort}` },
    primary,
  };
}

export function mockInstances(): InstanceSummary[] {
  const t = now();
  const base = {
    icon: null,
    category: 'productivity',
    revision: '1',
    desired: 'running' as const,
    observedAt: t,
    primaryEndpoint: 'web',
    operationId: null,
    hasRetainedData: false,
    updateAvailable: null,
    displayName: null,
    customIcon: null,
    usage: null,
    autoUpdate: false,
  };
  return [
    {
      ...base,
      id: 'inst-nextcloud',
      name: 'nextcloud',
      packageId: 'nextcloud',
      packageName: 'Nextcloud',
      displayName: 'Cloud',
      customIcon: { kind: 'glyph', glyph: '☁', color: '#3d9cff' },
      installState: 'installed',
      runtime: 'running',
      readiness: 'healthy',
      endpoints: [endpoint(18081)],
      usage: { cpuPercent: 12, memoryBytes: 512 * MiB, sampledAt: t },
      autoUpdate: true,
    },
    {
      ...base,
      id: 'inst-immich',
      name: 'immich',
      packageId: 'immich',
      packageName: 'Immich',
      category: 'media',
      installState: 'installed',
      runtime: 'running',
      readiness: 'healthy',
      endpoints: [endpoint(18082)],
      usage: { cpuPercent: 34, memoryBytes: 900 * MiB, sampledAt: t },
      updateAvailable: { revision: '2', version: 'v1.2.0', releaseNotes: 'Faster search' },
    },
    {
      ...base,
      id: 'inst-jellyfin',
      name: 'jellyfin',
      packageId: 'jellyfin',
      packageName: 'Jellyfin',
      category: 'media',
      desired: 'stopped',
      installState: 'installed',
      runtime: 'stopped',
      readiness: 'unknown',
      endpoints: [endpoint(18083)],
    },
    {
      ...base,
      id: 'inst-n8n',
      name: 'n8n',
      packageId: 'n8n',
      packageName: 'n8n',
      category: 'automation',
      installState: 'failed',
      runtime: 'stopped',
      readiness: 'unknown',
      endpoints: [endpoint(18084)],
    },
    {
      ...base,
      id: 'inst-memos',
      name: 'memos',
      packageId: 'memos',
      packageName: 'Memos',
      installState: 'needs_action',
      runtime: 'stopped',
      readiness: 'unknown',
      endpoints: [endpoint(18085)],
    },
    {
      ...base,
      id: 'inst-vaultwarden',
      name: 'vaultwarden',
      packageId: 'vaultwarden',
      packageName: 'Vaultwarden',
      category: 'security',
      installState: 'installed',
      runtime: 'running',
      readiness: 'unhealthy',
      endpoints: [endpoint(18086)],
      usage: { cpuPercent: 3, memoryBytes: 64 * MiB, sampledAt: t },
    },
    {
      ...base,
      id: 'inst-excalidraw',
      name: 'draw',
      packageId: 'excalidraw',
      packageName: 'Excalidraw',
      installState: 'retained',
      runtime: 'stopped',
      readiness: 'unknown',
      endpoints: [],
      hasRetainedData: true,
    },
  ];
}

export function mockSystem(): SystemDto {
  const t = now();
  return {
    version: '0.9.0',
    profile: 'local-preview',
    deviceName: 'homelab',
    hostname: 'harbor',
    lan: { enabled: false, url: null },
    update: { current: '0.9.0', latest: null, available: false, checkedAt: t, error: null, applying: null },
    docker: { available: true, observedAt: t, version: '29.8.1', error: null },
    busyOperationId: null,
    installationId: 'mock-installation',
    managementOrigin: 'http://localhost:5173',
  };
}

export function mockMetrics(): SystemMetricsDto {
  return {
    sampledAt: now(),
    uptimeSeconds: 3 * 86400 + 5 * 3600 + 42 * 60,
    host: { hostname: 'harbor', os: 'Ubuntu 24.04.4 LTS', arch: 'x64', cpuModel: 'Intel Core i7 (mock)' },
    temperatureC: 52,
    cpu: { cores: 4, load1: 0.8, load5: 0.6, load15: 0.4 },
    memory: { totalBytes: 8 * GiB, usedBytes: 3 * GiB },
    disk: { path: '/', totalBytes: 100 * GiB, usedBytes: 40 * GiB },
    docker: { available: true, version: '29.8.1', containersRunning: 5, containersTotal: 7 },
  };
}

export function mockHost(): SystemHostDto {
  return {
    hostname: 'harbor',
    os: 'Ubuntu 24.04.4 LTS',
    arch: 'x64',
    cpuModel: 'Intel Core i7 (mock)',
    power: { available: true, note: null },
  };
}

export function mockTools(): PlatformToolDto[] {
  const t = now();
  return [
    {
      id: 'tailscale',
      name: 'Tailscale',
      installationState: 'installed',
      availability: 'reachable',
      browserUrl: null,
      observedAt: t,
      note: null,
      mode: 'managed',
      facts: { dnsName: 'harbor.tail123.ts.net', tailnet: 'mock-tailnet', httpsEnabled: true },
    },
    {
      id: 'proxy',
      name: 'Public proxy',
      installationState: 'installed',
      availability: 'reachable',
      browserUrl: null,
      observedAt: t,
      note: null,
      mode: 'managed',
      facts: { publicIp: '203.0.113.7' },
    },
    {
      id: 'cockpit',
      name: 'Cockpit',
      installationState: 'not_installed',
      availability: 'unknown',
      browserUrl: null,
      observedAt: null,
      note: 'Not set up',
      mode: 'absent',
    },
    {
      id: 'portainer',
      name: 'Portainer',
      installationState: 'not_installed',
      availability: 'unknown',
      browserUrl: null,
      observedAt: null,
      note: 'Not set up',
      mode: 'absent',
    },
  ];
}

export function mockExposures(): { items: ExposureDto[]; ui: UiExposureDto | null } {
  return {
    items: [
      {
        id: 'exp-nextcloud',
        instanceId: 'inst-nextcloud',
        instanceName: 'Nextcloud',
        endpointId: 'web',
        via: 'tailnet',
        url: 'https://nextcloud.harbor.tail123.ts.net',
        hostname: 'nextcloud.harbor.tail123.ts.net',
        port: 443,
        protection: 'none',
        state: 'active',
        observedAt: now(),
        note: null,
        isPrimary: true,
      },
    ],
    ui: { via: 'tailnet', url: 'https://harbor.harbor.tail123.ts.net', state: 'active', note: null },
  };
}

export function mockAppearance(): AppearanceDto {
  return {
    wallpaper: { kind: 'none', version: null, current: null },
    rotation: {
      enabled: false,
      source: 'bing',
      subreddits: [],
      everyHours: 24,
      nextAt: null,
      lastError: null,
      reddit: { clientId: null, hasSecret: false },
    },
    home: { order: [] },
  };
}

export function mockNotifications(): NotificationsDto {
  const t = Date.now();
  return {
    unread: 2,
    items: [
      {
        id: 'ntf-1',
        createdAt: new Date(t - 5 * 60 * 1000).toISOString(),
        kind: 'update',
        severity: 'info',
        title: 'Immich 2 is available',
        body: 'Revision 1 → 2 (v1.2.0). Your data and addresses stay.',
        instanceId: 'inst-immich',
        read: false,
      },
      {
        id: 'ntf-2',
        createdAt: new Date(t - 2 * 3600 * 1000).toISOString(),
        kind: 'disk',
        severity: 'warning',
        title: 'Photos disk is filling up',
        body: '/mnt/photos is 82% full. Consider freeing space.',
        instanceId: null,
        read: false,
      },
      {
        id: 'ntf-3',
        createdAt: new Date(t - 26 * 3600 * 1000).toISOString(),
        kind: 'backup',
        severity: 'error',
        title: 'n8n failed to start',
        body: 'The new revision did not answer health checks; the previous one was kept.',
        instanceId: 'inst-n8n',
        read: true,
      },
    ],
  };
}

export function mockChannels(): NotificationChannelDto[] {
  return [];
}

export function mockStorage(): HostStorageDto {
  return {
    dataFolder: { path: '/srv/harbor', exists: true, writable: true },
    mounts: [
      { mountpoint: '/', device: '/dev/sda1', fsType: 'ext4', totalBytes: 100 * GiB, usedBytes: 40 * GiB, writable: true, label: 'System disk' },
      { mountpoint: '/mnt/photos', device: '/dev/sdb1', fsType: 'ext4', totalBytes: 500 * GiB, usedBytes: 410 * GiB, writable: true, label: 'Photos' },
    ],
    devices: [
      { name: 'sdc1', device: '/dev/sdc1', size: '14.4G', fsType: 'vfat', label: 'USB20FD', uuid: 'ABCD-1234', removable: true, mounted: false, mountpoint: null },
    ],
    inUse: [{ path: '/mnt/photos', instanceId: 'inst-immich', instanceName: 'Immich', purpose: 'Photo library', readOnly: false }],
  };
}

export function mockStorageUsage(): StorageUsageDto {
  return {
    sampledAt: now(),
    apps: [
      {
        instanceId: 'inst-nextcloud',
        name: 'Nextcloud',
        volumes: [{ id: 'data', volumeName: 'hb_mock_data', sizeBytes: 12 * GiB }],
        totalBytes: 12 * GiB,
      },
      {
        instanceId: 'inst-immich',
        name: 'Immich',
        volumes: [
          { id: 'library', volumeName: 'hb_mock_library', sizeBytes: 30 * GiB },
          { id: 'thumbs', volumeName: 'hb_mock_thumbs', sizeBytes: 4 * GiB },
        ],
        totalBytes: 34 * GiB,
      },
    ],
    unownedBytes: 512 * MiB,
  };
}

export function mockDomains(): DomainsDto {
  const t = now();
  return {
    publicIp: { v4: '203.0.113.7', v6: null, detectedAt: t, error: null },
    items: [
      {
        hostname: 'cloud.example.com',
        dns: { state: 'points_here', addresses: ['203.0.113.7'], checkedAt: t, note: null },
        usedBy: null,
      },
    ],
  };
}
