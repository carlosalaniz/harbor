import { DIGEST_PATTERN, ID_PATTERN, IMAGE_REF_PATTERN, REVISION_PATTERN, SHA256_HEX_PATTERN } from './patterns.js';

export const RELEASE_FILES = ['manifest.yaml', 'compose.yaml', 'README.md'] as const;

export const RELEASE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://harbor.local/schemas/release.json',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'package', 'files', 'images', 'qualification'],
  // `assets`: sha256 of presentation files (icon/gallery) referenced by the manifest; required when the manifest references any.
  properties: {
    schemaVersion: { const: 1 },
    package: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'revision'],
      properties: { id: { type: 'string', pattern: ID_PATTERN }, revision: { type: 'string', pattern: REVISION_PATTERN } },
    },
    files: {
      type: 'object',
      additionalProperties: false,
      required: [...RELEASE_FILES],
      properties: Object.fromEntries(
        RELEASE_FILES.map((f) => [
          f,
          { type: 'object', additionalProperties: false, required: ['sha256'], properties: { sha256: { type: 'string', pattern: SHA256_HEX_PATTERN } } },
        ]),
      ),
    },
    assets: {
      type: 'object',
      propertyNames: { pattern: '^[a-z0-9][a-z0-9._-]{0,63}\\.(svg|png|jpg|jpeg|webp)$' },
      additionalProperties: { type: 'object', additionalProperties: false, required: ['sha256'], properties: { sha256: { type: 'string', pattern: SHA256_HEX_PATTERN } } },
    },
    // Built services (git sources, decision 80): provenance is the commit, the image is local-only.
    builds: {
      type: 'object',
      propertyNames: { pattern: ID_PATTERN },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['context', 'commit', 'tag'],
        properties: {
          context: { type: 'string', maxLength: 220 },
          dockerfile: { type: 'string', maxLength: 220 },
          commit: { type: 'string', pattern: '^[0-9a-f]{40}$' },
          tag: { type: 'string', maxLength: 200 },
        },
      },
    },
    images: {
      type: 'object',
      propertyNames: { pattern: ID_PATTERN },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['reference', 'repository', 'tag', 'platform', 'platformDigest'],
        properties: {
          reference: { type: 'string', pattern: IMAGE_REF_PATTERN },
          repository: { type: 'string', minLength: 1 },
          tag: { type: 'string', minLength: 1, maxLength: 128 },
          platform: { const: 'linux/amd64' },
          platformDigest: { type: 'string', pattern: DIGEST_PATTERN },
          appVersion: { type: 'string', maxLength: 128 },
          imageCreated: { type: 'string', maxLength: 64 },
          source: { type: 'string', maxLength: 256 },
        },
      },
    },
    qualification: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'date', 'notes'],
      properties: {
        status: { enum: ['passed', 'blocked', 'pending'] },
        date: { type: 'string', maxLength: 64 },
        node: { type: 'string', maxLength: 64 },
        dockerEngine: { type: 'string', maxLength: 64 },
        dockerCompose: { type: 'string', maxLength: 64 },
        hostOs: { type: 'string', maxLength: 128 },
        appVersions: { type: 'object', additionalProperties: { type: 'string', maxLength: 128 } },
        notes: { type: 'array', items: { type: 'string', maxLength: 1000 }, maxItems: 64 },
      },
    },
  },
} as const;

export const CATALOG_INDEX_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://harbor.local/schemas/catalog-index.json',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'packages'],
  properties: {
    schemaVersion: { const: 1 },
    packages: {
      type: 'object',
      propertyNames: { pattern: ID_PATTERN },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['revision', 'dir'],
        properties: {
          revision: { type: 'string', pattern: REVISION_PATTERN },
          dir: { type: 'string', pattern: ID_PATTERN },
        },
      },
    },
  },
} as const;
