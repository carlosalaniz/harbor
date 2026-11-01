import type {
  AppearanceDto,
  CatalogItemDto,
  CatalogStatusDto,
  DomainsDto,
  EndpointDto,
  ExposureDto,
  GpuDto,
  HostStorageDto,
  InstanceSummary,
  NotificationChannelDto,
  NotificationsDto,
  OperationDto,
  PlatformToolDto,
  PrimaryExposure,
  StorageUsageDto,
  SystemDto,
  SystemHostDto,
  SystemMetricsDto,
  SettingDto,
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
    requiresHttps: false,
    presentation: {
      tagline: description,
      category: 'productivity',
      icon: null,
      gallery: [],
      developer: 'Mock developer',
      website: `https://${id}.example.org`,
      source: `https://github.com/example/${id}`,
      releaseNotes: null,
      sizeHint: null,
      hasWidget: false,
    },
    defaultCredentials: null,
    setup: false,
    storage: 0,
    claims: [],
    operatorSecrets: [],
    links: [],
    multiInstance: true,
    ...extra,
  });
  return [
    app('nextcloud', 'Nextcloud', 'Files, calendar and contacts on your machine'),
    app('immich', 'Immich', 'Photo backup and timeline', {
      revision: '2',
      version: '3.3.1',
      claims: [{ id: 'library', purpose: 'Photo library', external: { hint: '/photos', required: false, readOnly: false } }],
      presentation: {
        tagline: 'Photo backup and timeline',
        category: 'media',
        icon: null,
        gallery: [],
        developer: 'Mock developer',
        website: null,
        source: null,
        releaseNotes: null,
        sizeHint: 'About 4 GB, plus your photos and videos',
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
        source: null,
        releaseNotes: null,
        sizeHint: null,
        hasWidget: false,
      },
    }),
    // decision 170: a one-copy app — once installed, its Store card shows Open only
    app('vaultwarden', 'Vaultwarden', 'Password manager for the whole family', {
      multiInstance: false,
      presentation: {
        tagline: 'Password manager for the whole family',
        category: 'security',
        icon: null,
        gallery: [],
        developer: 'Mock developer',
        website: null,
        source: null,
        releaseNotes: null,
        sizeHint: null,
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
        source: null,
        releaseNotes: null,
        sizeHint: null,
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
        source: null,
        releaseNotes: null,
        sizeHint: null,
        hasWidget: false,
      },
    }),
    app('excalidraw', 'Excalidraw', 'Whiteboard for quick sketches and diagrams'),
    // decision 170: a one-copy app whose only copy was removed (data kept) — its card shows Reinstall…
    app('open-webui', 'Open WebUI', 'Chat with models running on your machine', {
      multiInstance: false,
      presentation: {
        tagline: 'Chat with models running on your machine',
        category: 'ai',
        icon: null,
        gallery: [],
        developer: 'Mock developer',
        website: null,
        source: null,
        releaseNotes: null,
        sizeHint: null,
        hasWidget: false,
      },
    }),
    // decisions 179/180: a model server that asks for the graphics card and has settings
    app('ollama', 'Ollama', 'Run language models on your own machine', {
      multiInstance: false,
      presentation: {
        tagline: 'Run language models on your own machine',
        category: 'ai',
        icon: null,
        gallery: [],
        developer: 'Mock developer',
        website: null,
        source: null,
        releaseNotes: null,
        sizeHint: 'About 1 GB, plus your models',
        hasWidget: false,
      },
    }),
  ];
}

// Decision 180: Ollama's server settings as its package would declare them (values as an install would have them).
export function mockOllamaSettings(): SettingDto[] {
  const s = (x: Partial<SettingDto> & Pick<SettingDto, 'id' | 'label' | 'type' | 'default'>): SettingDto => ({ help: null, value: x.default, overridden: false, min: null, max: null, maxLength: null, choices: null, ...x });
  return [
    s({ id: 'context-length', label: 'Context length (tokens)', help: 'How much text a model keeps in mind. More uses more memory.', type: 'integer', default: 8192, value: 16384, overridden: true, min: 2048, max: 131072 }),
    s({ id: 'keep-alive', label: 'Keep models loaded', help: 'How long a model stays in memory after a request, e.g. 5m or 1h.', type: 'string', default: '5m', maxLength: 16 }),
    s({ id: 'parallel', label: 'Parallel requests', type: 'integer', default: 1, min: 1, max: 8 }),
    s({ id: 'max-loaded', label: 'Models loaded at once', type: 'integer', default: 1, min: 1, max: 4 }),
    s({ id: 'flash-attention', label: 'Flash attention', help: 'Faster, uses less memory on supported cards.', type: 'boolean', default: false, value: true, overridden: true }),
    s({ id: 'kv-cache', label: 'Memory cache precision', type: 'choice', default: 'f16', choices: [{ value: 'f16', label: 'Full (f16)' }, { value: 'q8_0', label: 'Half (q8_0)' }, { value: 'q4_0', label: 'Quarter (q4_0)' }] }),
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
    version: null as string | null,
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
    needsDrive: null,
    home: null,
    links: [],
    linkedBy: [],
    operatorSecrets: [],
    hiddenFromHome: false,
    apiOnly: false,
    ports: [],
    internet: { mode: 'direct' as const, choice: null, packageDefault: 'direct' as const, allApps: false },
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
      version: '3.2.1',
      updateAvailable: { revision: '2', version: '3.3.1', releaseNotes: 'Faster search' },
    },
    // decision 170: a second copy of Immich — both tiles name their copy, the Store offers a third
    {
      ...base,
      id: 'inst-immich-2',
      name: 'immich-2',
      packageId: 'immich',
      packageName: 'Immich',
      category: 'media',
      installState: 'installed',
      runtime: 'running',
      readiness: 'healthy',
      endpoints: [endpoint(18087)],
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
    {
      ...base,
      id: 'inst-open-webui',
      name: 'open-webui',
      packageId: 'open-webui',
      packageName: 'Open WebUI',
      category: 'ai',
      installState: 'retained',
      runtime: 'stopped',
      readiness: 'unknown',
      endpoints: [],
      hasRetainedData: true,
    },
    {
      ...base,
      id: 'inst-ollama',
      name: 'ollama',
      packageId: 'ollama',
      packageName: 'Ollama',
      category: 'ai',
      installState: 'installed',
      runtime: 'running',
      readiness: 'healthy',
      endpoints: [endpoint(18088)],
      usage: { cpuPercent: 8, memoryBytes: 2048 * MiB, sampledAt: t },
      settings: mockOllamaSettings(),
    },
    {
      // decision 183: installing right now (the queue fixture's running item)
      ...base,
      id: 'inst-freshrss',
      name: 'freshrss',
      packageId: 'freshrss',
      packageName: 'FreshRSS',
      category: 'productivity',
      installState: 'installing',
      runtime: 'unknown',
      readiness: 'unknown',
      endpoints: [endpoint(18089)],
      operationId: 'op-mock-q-install',
    },
  ];
}

// Decision 183: the queue — a running install, then two waiting items in run order: an Update queued by the owner
// (planned at its turn, cancellable) and a Stop the drive guard queued (not cancellable).
export function mockQueue(): OperationDto[] {
  const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const op = (o: Partial<OperationDto> & Pick<OperationDto, 'id' | 'kind' | 'instanceId' | 'instanceName'>): OperationDto => ({ planId: null, actor: 'admin', queuedAction: false, cancellable: true, state: 'queued', phase: 'queued', createdAt: at(30), startedAt: null, finishedAt: null, error: null, result: null, events: [], ...o });
  return [
    op({ id: 'op-mock-q-install', kind: 'install', instanceId: 'inst-freshrss', instanceName: 'FreshRSS', planId: 'plan-mock-q-install', state: 'applying', phase: 'pulling', createdAt: at(50), startedAt: at(45), cancellable: false }),
    op({ id: 'op-mock-q-update', kind: 'update', instanceId: 'inst-immich', instanceName: 'Immich', queuedAction: true, createdAt: at(40) }),
    op({ id: 'op-mock-q-stop', kind: 'stop', instanceId: 'inst-jellyfin', instanceName: 'Jellyfin', planId: 'plan-mock-q-stop', actor: 'drive-guard', cancellable: false, createdAt: at(20) }),
  ];
}

function devModeParam(): string | null {
  return typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('devmode') : null;
}

export function mockSystem(): SystemDto {
  const t = now();
  return {
    version: '0.9.0',
    profile: 'local-preview',
    deviceName: 'homelab',
    hostname: 'harbor',
    lan: { enabled: false, url: null },
    network: { https: { enabled: false, httpsOnly: false, url: null, fingerprint: null, expiresAt: null, hosts: [] } },
    update: { current: '0.9.0', latest: null, available: false, checkedAt: t, error: null, applying: null },
    docker: { available: true, observedAt: t, version: '29.8.1', error: null },
    busyOperationId: null,
    installationId: 'mock-installation',
    managementOrigin: 'http://localhost:5173',
    unlockNeeded: false,
    // decision 193: ?devmode=on previews the banner
    developerMode: { enabled: devModeParam() === 'on', since: devModeParam() === 'on' ? t : null, untrustedApps: [] },
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

// The mock machine's graphics card (decisions 179, 181). Preview switches: ?gpu=driver-missing | reboot-needed |
// driver-too-old | toolkit-missing | restart-needed | dri | none (default: a working NVIDIA card)
const RTX = 'NVIDIA GeForce RTX 3090';
const MOCK_GPUS: Record<string, GpuDto> = {
  nvidia: { kind: 'nvidia', detail: RTX, driverVersion: '595.99.02', libraryVersion: '595.99.02' },
  'driver-missing': { kind: 'none', detail: 'NVIDIA graphics card', problem: 'NVIDIA_DRIVER_MISSING' },
  'reboot-needed': { kind: 'none', detail: RTX, problem: 'NVIDIA_REBOOT_NEEDED', driverVersion: '550.163.01', libraryVersion: '595.99.02' },
  'driver-too-old': { kind: 'nvidia', detail: RTX, problem: 'NVIDIA_DRIVER_TOO_OLD', driverVersion: '470.256.02', libraryVersion: '470.256.02' },
  'toolkit-missing': { kind: 'none', detail: RTX, problem: 'NVIDIA_TOOLKIT_MISSING', driverVersion: '595.99.02', libraryVersion: '595.99.02' },
  'restart-needed': { kind: 'none', detail: RTX, problem: 'NVIDIA_DOCKER_RESTART_NEEDED', driverVersion: '595.99.02', libraryVersion: '595.99.02' },
  dri: { kind: 'dri', detail: 'Intel graphics' },
  none: { kind: 'none', detail: 'No graphics card found' },
};
export function mockGpu(): GpuDto {
  const m = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('gpu') : null;
  return MOCK_GPUS[m ?? 'nvidia'] ?? MOCK_GPUS['nvidia']!;
}

export function mockHost(): SystemHostDto {
  return {
    hostname: 'harbor',
    os: 'Ubuntu 24.04.4 LTS',
    arch: 'x64',
    cpuModel: 'Intel Core i7 (mock)',
    power: { available: true, note: null },
    gpu: mockGpu(),
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
      // decision 189: public names (one broken) and a tailnet port so Publishing shows every group
      { id: 'exp-nextcloud-pub', instanceId: 'inst-nextcloud', instanceName: 'nextcloud', endpointId: 'web', via: 'public', url: 'https://cloud.example.com/', hostname: 'cloud.example.com', port: 443, protection: 'none', state: 'active', observedAt: now(), note: null, isPrimary: false },
      { id: 'exp-immich-pub', instanceId: 'inst-immich', instanceName: 'immich', endpointId: 'web', via: 'public', url: 'https://photos.example.com/', hostname: 'photos.example.com', port: 443, protection: 'none', state: 'active', observedAt: now(), note: null, isPrimary: true },
      { id: 'exp-immich-pub2', instanceId: 'inst-immich', instanceName: 'immich', endpointId: 'web', via: 'public', url: 'https://photos.example.org/', hostname: 'photos.example.org', port: 443, protection: 'basic', state: 'degraded', observedAt: now(), note: 'not reachable: getaddrinfo ENOTFOUND photos.example.org', isPrimary: false },
      { id: 'exp-ollama-tn', instanceId: 'inst-ollama', instanceName: 'ollama', endpointId: 'web', via: 'tailnet', url: 'https://harbor.harbor.tail123.ts.net:18999/', hostname: 'harbor.harbor.tail123.ts.net', port: 18999, protection: 'none', state: 'active', observedAt: now(), note: null, isPrimary: true },
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
        read: false, link: null,
        actions: [{ label: 'Update now', do: 'update-app', route: null }],
      },
      {
        id: 'ntf-2',
        createdAt: new Date(t - 2 * 3600 * 1000).toISOString(),
        kind: 'disk',
        severity: 'warning',
        title: 'Photos disk is filling up',
        body: '/mnt/photos is 82% full. Consider freeing space.',
        instanceId: null,
        read: false, link: '#/settings/storage',
        actions: [{ label: 'See storage', do: 'route', route: '#/settings/storage' }],
      },
      {
        id: 'ntf-3',
        createdAt: new Date(t - 26 * 3600 * 1000).toISOString(),
        kind: 'backup',
        severity: 'error',
        title: 'n8n failed to start',
        body: 'The new revision did not answer health checks; the previous one was kept.',
        instanceId: 'inst-n8n',
        read: true, link: null,
        actions: [{ label: 'Open app', do: 'open-app', route: null }],
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
      { name: 'sdb1', device: '/dev/sdb1', size: '500G', fsType: 'ext4', label: 'Photos', uuid: 'd1e2f3a4', removable: true, mounted: true, mountpoint: '/mnt/photos', mountedBy: 'harbor', attention: null, dismissed: false },
      { name: 'sdc1', device: '/dev/sdc1', size: '14.4G', fsType: 'vfat', label: 'USB20FD', uuid: 'ABCD-1234', removable: true, mounted: false, mountpoint: null, mountedBy: null, attention: null, dismissed: false },
    ],
    inUse: [{ path: '/mnt/photos', instanceId: 'inst-immich', instanceName: 'Immich', purpose: 'Photo library', readOnly: false }],
    storagePolicy: { autoMount: true, autoStart: true },
    installCandidates: [
      { dir: '/srv/harbor/harbor-apps', label: 'Harbor data folder (/srv/harbor/harbor-apps)', fsType: 'unknown', totalBytes: 100 * GiB, usedBytes: 40 * GiB, writable: true, eligible: true, reason: null },
      { dir: '/mnt/photos/harbor-apps', label: 'Photos (/mnt/photos/harbor-apps)', fsType: 'ext4', totalBytes: 500 * GiB, usedBytes: 410 * GiB, writable: true, eligible: true, reason: null },
    ],
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

// The official catalog line under the Store (decision 158). Preview switches:
//   ?catalog=off    updates off (no button)
//   ?catalog=error  the last automatic check failed (shown on load; Check for new apps fails again)
//   ?catalog=new    Check for new apps finds a newer catalog ("New apps and updates loaded")
export function mockCatalogMode(): 'off' | 'error' | 'new' | null {
  const m = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('catalog') : null;
  return m === 'off' || m === 'error' || m === 'new' ? m : null;
}
export const MOCK_CATALOG_ERROR = 'could not download catalog.json from the catalog server (getaddrinfo ENOTFOUND github.com)';
export function mockCatalogStatus(): CatalogStatusDto {
  const mode = mockCatalogMode();
  const off = mode === 'off';
  return {
    source: off ? null : 'https://github.com/carlosalaniz/harbor-apps/releases/latest/download',
    serial: 1_791_000_000,
    commit: '3f9c2a1b7d4e',
    createdAt: '2026-10-03T09:12:00Z',
    origin: off ? 'bundled' : 'downloaded',
    packages: mockCatalog().length,
    checkedAt: off ? null : new Date(Date.now() - 42 * 60_000).toISOString(),
    error: mode === 'error' ? MOCK_CATALOG_ERROR : null,
  };
}
