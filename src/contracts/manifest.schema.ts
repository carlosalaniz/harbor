import { PRODUCT } from '../naming.js';
import { ENV_KEY_PATTERN, ID_PATTERN, RELATIVE_PATH_PATTERN, REVISION_PATTERN } from './patterns.js';

const idString = { type: 'string', pattern: ID_PATTERN } as const;
const envKey = { type: 'string', pattern: ENV_KEY_PATTERN } as const;
const plainText = (maxLength: number) =>
  ({ type: 'string', minLength: 1, maxLength, pattern: '^[^<>\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]*$' }) as const;

export const MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://harbor.local/schemas/manifest.json',
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion', 'kind', 'metadata', 'release', 'deployment', 'endpoints', 'health', 'ui'],
  // `presentation` is an optional, additive block for the console (docs/design/UI.md §3).
  properties: {
    apiVersion: { const: PRODUCT.apiVersion },
    kind: { const: 'Application' },
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'description'],
      properties: {
        id: idString,
        name: plainText(64),
        description: plainText(280),
      },
    },
    release: {
      type: 'object',
      additionalProperties: false,
      required: ['revision'],
      properties: { revision: { type: 'string', pattern: REVISION_PATTERN } },
    },
    deployment: {
      type: 'object',
      additionalProperties: false,
      required: ['compose', 'multiInstance', 'services'],
      properties: {
        compose: { const: 'compose.yaml' },
        multiInstance: { type: 'boolean' },
        services: {
          type: 'object',
          minProperties: 1,
          maxProperties: 16,
          propertyNames: { pattern: ID_PATTERN },
          additionalProperties: { enum: ['application', 'infrastructure'] },
        },
      },
    },
    endpoints: {
      type: 'object',
      minProperties: 1,
      maxProperties: 16,
      propertyNames: { pattern: ID_PATTERN },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['service', 'containerPort', 'scheme', 'exposure', 'browserContext'],
        properties: {
          service: idString,
          containerPort: { type: 'integer', minimum: 1, maximum: 65535 },
          scheme: { const: 'http' },
          exposure: { const: 'direct' },
          browserContext: { enum: ['secure', 'ordinary'] },
        },
      },
    },
    health: {
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'path', 'expectedStatus', 'timeoutSeconds', 'deadlineSeconds'],
      properties: {
        endpoint: idString,
        path: { type: 'string', pattern: RELATIVE_PATH_PATTERN, maxLength: 512 },
        expectedStatus: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: { type: 'integer', minimum: 100, maximum: 599 },
        },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 30 },
        deadlineSeconds: { type: 'integer', minimum: 1, maximum: 600 },
      },
    },
    ui: {
      type: 'object',
      additionalProperties: false,
      required: ['primaryEndpoint'],
      properties: { primaryEndpoint: idString },
    },
    storage: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'composeVolume', 'purpose', 'retention'],
        properties: {
          id: idString,
          composeVolume: idString,
          purpose: plainText(120),
          retention: { const: 'retain' },
        },
      },
    },
    secrets: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'bytes', 'encoding', 'retention', 'bindings'],
        properties: {
          id: idString,
          bytes: { const: 32 },
          encoding: { const: 'hex' },
          retention: { const: 'retain' },
          bindings: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['service', 'environment'],
              properties: { service: idString, environment: envKey },
            },
          },
        },
      },
    },
    configuration: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['service', 'environment', 'endpoint'],
        properties: { service: idString, environment: envKey, endpoint: idString },
      },
    },
    setup: {
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'instructions'],
      properties: { endpoint: idString, instructions: plainText(1000) },
    },
    presentation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tagline: plainText(80),
        category: { enum: ['productivity', 'media', 'files', 'automation', 'network', 'developer', 'other'] },
        icon: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}\\.(svg|png)$' },
        gallery: { type: 'array', maxItems: 6, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}\\.(png|jpg|jpeg|webp)$' } },
        developer: plainText(80),
        website: { type: 'string', pattern: '^https://[^\\s<>"]{1,200}$' },
        releaseNotes: plainText(1000),
      },
    },
  },
} as const;
