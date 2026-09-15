// Runtime types matching the JSON Schemas. Kept by hand and checked by tests
// (schema validation of fixtures + TypeScript compile of the same fixtures).

export type ServiceRole = 'application' | 'infrastructure';

export interface Manifest {
  apiVersion: 'harbor/v1alpha1';
  kind: 'Application';
  metadata: { id: string; name: string; description: string };
  release: { revision: string; version?: string };
  deployment: { compose: 'compose.yaml'; multiInstance: boolean; services: Record<string, ServiceRole> };
  endpoints: Record<string, ManifestEndpoint>;
  health: { endpoint: string; path: string; expectedStatus: number[]; timeoutSeconds: number; deadlineSeconds: number };
  ui: { primaryEndpoint: string };
  storage?: StorageClaim[];
  secrets?: SecretClaim[];
  configuration?: ConfigurationBinding[];
  setup?: { endpoint: string; instructions: string };
  presentation?: PackagePresentation;
  defaultCredentials?: { username: string; password: string; note?: string };
}

export type PackageCategory = 'productivity' | 'media' | 'files' | 'automation' | 'network' | 'developer' | 'ai' | 'security' | 'finance' | 'home' | 'other';
export interface PackagePresentation {
  tagline?: string;
  category?: PackageCategory;
  icon?: string;
  gallery?: string[];
  developer?: string;
  website?: string;
  releaseNotes?: string;
}

export interface ManifestEndpoint {
  service: string;
  containerPort: number;
  scheme: 'http';
  exposure: 'direct';
  browserContext: 'secure' | 'ordinary';
}

export interface StorageClaim {
  id: string;
  composeVolume: string;
  purpose: string;
  retention: 'retain';
  // present when the operator may bind the claim to a host directory ("bring your own folder")
  external?: { hint: string; required?: boolean; readOnly?: boolean };
}
export interface SecretClaim {
  id: string;
  bytes: 32;
  encoding: 'hex';
  retention: 'retain';
  bindings: { service: string; environment: string }[];
}
export type ConfigurationFormat = 'url' | 'origin' | 'authority' | 'host' | 'scheme';
export interface ConfigurationBinding { service: string; environment: string; endpoint: string; format?: ConfigurationFormat }

export interface ComposeSourceService {
  image: string;
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition: 'service_started' | 'service_healthy' }>;
  healthcheck?: { test: string[]; interval?: string; timeout?: string; retries?: number; start_period?: string };
  volumes?: { type: 'volume'; source: string; target: string; read_only?: boolean }[];
}
export interface ComposeSource {
  services: Record<string, ComposeSourceService>;
  volumes?: Record<string, Record<string, never>>;
}

export interface ReleaseImage {
  reference: string;
  repository: string;
  tag: string;
  platform: 'linux/amd64';
  platformDigest: string;
  appVersion?: string;
  imageCreated?: string;
  source?: string;
}
export interface ReleaseInventory {
  schemaVersion: 1;
  package: { id: string; revision: string };
  files: Record<'manifest.yaml' | 'compose.yaml' | 'README.md', { sha256: string }>;
  assets?: Record<string, { sha256: string }>;
  images: Record<string, ReleaseImage>;
  qualification: {
    status: 'passed' | 'blocked' | 'pending';
    date: string;
    node?: string;
    dockerEngine?: string;
    dockerCompose?: string;
    hostOs?: string;
    appVersions?: Record<string, string>;
    notes: string[];
  };
}

export interface CatalogIndex {
  schemaVersion: 1;
  packages: Record<string, { revision: string; dir: string }>;
}

export interface LoadedPackage {
  id: string;
  revision: string;
  dir: string;
  manifest: Manifest;
  compose: ComposeSource;
  release: ReleaseInventory;
  readme: string;
  raw: { manifest: Buffer; compose: Buffer; readme: Buffer; release: Buffer };
  hashes: Record<'manifest.yaml' | 'compose.yaml' | 'README.md', string>;
  // presentation assets (icon, gallery) verified against release.json `assets`
  assets: Record<string, Buffer>;
}
