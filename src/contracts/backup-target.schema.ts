import { PRODUCT } from '../naming.js';
import { ID_PATTERN, REVISION_PATTERN } from './patterns.js';

// Decision 152: a backup target package is a form plus a transport word — data only, no code.
// The transport picks built-in code (src/backups/restic.ts); for rclone every field names the
// rclone option it fills, and the package names the backend.

export type BackupTransport = 'local' | 's3' | 'sftp' | 'rclone' | 'rest';
export const BACKUP_TRANSPORTS: readonly BackupTransport[] = ['local', 's3', 'sftp', 'rclone', 'rest'];

export interface BackupTargetField {
  id: string;
  label: string;
  type: 'text' | 'secret' | 'textarea' | 'number';
  required?: boolean;
  default?: string;
  hint?: string;
  rclone?: string; // transport rclone: the backend option this field fills
  obscure?: boolean; // transport rclone: pass through `rclone obscure` (passwords)
}

export interface BackupTargetManifest {
  apiVersion: string;
  kind: 'BackupTarget';
  metadata: { id: string; name: string; description: string; status: 'stable' | 'beta' };
  release: { revision: string };
  transport: BackupTransport;
  rclone?: { backend: string };
  fields: BackupTargetField[];
}

const plainText = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001F]*$' }) as const;

export const BACKUP_TARGET_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://harbor.local/schemas/backup-target.json',
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion', 'kind', 'metadata', 'release', 'transport', 'fields'],
  properties: {
    apiVersion: { const: PRODUCT.apiVersion },
    kind: { const: 'BackupTarget' },
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'description', 'status'],
      properties: { id: { type: 'string', pattern: ID_PATTERN }, name: plainText(64), description: plainText(280), status: { enum: ['stable', 'beta'] } },
    },
    release: { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: { type: 'string', pattern: REVISION_PATTERN } } },
    transport: { enum: [...BACKUP_TRANSPORTS] },
    rclone: { type: 'object', additionalProperties: false, required: ['backend'], properties: { backend: { type: 'string', pattern: '^[a-z][a-z0-9]{1,31}$' } } },
    fields: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'type'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][A-Za-z0-9]{0,31}$' },
          label: plainText(64),
          type: { enum: ['text', 'secret', 'textarea', 'number'] },
          required: { type: 'boolean' },
          default: { type: 'string', maxLength: 256 },
          hint: plainText(200),
          rclone: { type: 'string', pattern: '^[a-z0-9][a-z0-9_]{0,47}$' },
          obscure: { type: 'boolean' },
        },
      },
    },
  },
} as const;

// The field ids each built-in transport reads (rclone reads whatever the package maps).
export const TRANSPORT_FIELDS: Record<Exclude<BackupTransport, 'rclone'>, { required: string[]; optional: string[] }> = {
  local: { required: ['path'], optional: [] },
  s3: { required: ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'], optional: ['path', 'region'] },
  sftp: { required: ['host', 'user', 'path', 'privateKey'], optional: ['port', 'hostKey'] },
  rest: { required: ['url'], optional: ['username', 'password'] },
};
