import { ABSOLUTE_CONTAINER_PATH_PATTERN, DURATION_PATTERN, ENV_KEY_PATTERN, ID_PATTERN, IMAGE_REF_PATTERN } from './patterns.js';

// The supported *source* Compose subset (TDD section 4.3). Everything not listed is rejected.
export const COMPOSE_SOURCE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://harbor.local/schemas/compose-source.json',
  type: 'object',
  additionalProperties: false,
  required: ['services'],
  properties: {
    services: {
      type: 'object',
      minProperties: 1,
      maxProperties: 16,
      propertyNames: { pattern: ID_PATTERN },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['image'],
        properties: {
          image: { type: 'string', pattern: IMAGE_REF_PATTERN, maxLength: 400 },
          environment: {
            type: 'object',
            maxProperties: 64,
            propertyNames: { pattern: ENV_KEY_PATTERN },
            additionalProperties: { type: 'string', maxLength: 4096 },
          },
          depends_on: {
            type: 'object',
            maxProperties: 16,
            propertyNames: { pattern: ID_PATTERN },
            additionalProperties: {
              type: 'object',
              additionalProperties: false,
              required: ['condition'],
              properties: { condition: { enum: ['service_started', 'service_healthy'] } },
            },
          },
          healthcheck: {
            type: 'object',
            additionalProperties: false,
            required: ['test'],
            properties: {
              test: {
                type: 'array',
                minItems: 2,
                maxItems: 32,
                // First element must be the literal CMD (argument-array form only).
                prefixItems: [{ const: 'CMD' }],
                items: { type: 'string', maxLength: 512, minLength: 1 },
              },
              interval: { type: 'string', pattern: DURATION_PATTERN },
              timeout: { type: 'string', pattern: DURATION_PATTERN },
              retries: { type: 'integer', minimum: 1, maximum: 100 },
              start_period: { type: 'string', pattern: DURATION_PATTERN },
            },
          },
          volumes: {
            type: 'array',
            maxItems: 16,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'source', 'target'],
              properties: {
                type: { const: 'volume' },
                source: { type: 'string', pattern: ID_PATTERN },
                target: { type: 'string', pattern: ABSOLUTE_CONTAINER_PATH_PATTERN, maxLength: 512 },
                read_only: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    volumes: {
      type: 'object',
      maxProperties: 16,
      propertyNames: { pattern: ID_PATTERN },
      additionalProperties: { type: 'object', additionalProperties: false, maxProperties: 0 },
    },
  },
} as const;

export const HEALTHCHECK_BOUNDS = {
  intervalMs: { min: 1_000, max: 300_000 },
  timeoutMs: { min: 1_000, max: 120_000 },
  startPeriodMs: { min: 0, max: 600_000 },
} as const;
