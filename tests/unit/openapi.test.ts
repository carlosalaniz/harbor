import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateOpenApi } from '../../src/api/openapi.js';

describe('OpenAPI description', () => {
  it('covers exactly the implemented routes and matches the committed document', async () => {
    const doc = await generateOpenApi();
    const paths = Object.keys(doc['paths'] as object).sort();
    expect(paths).toEqual(['/healthz', '/v1/catalog', '/v1/instances', '/v1/instances/{id}', '/v1/operations', '/v1/operations/{id}', '/v1/plans', '/v1/plans/{id}', '/v1/platform-tools', '/v1/sessions', '/v1/sessions/current', '/v1/system']);
    const committed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../docs/openapi.json'), 'utf8'));
    expect(committed.paths).toEqual(doc['paths']);
    // Login and liveness are the only unauthenticated routes.
    const p = doc['paths'] as Record<string, Record<string, { security?: unknown[] }>>;
    expect(p['/healthz']!['get']!.security).toEqual([]);
    expect(p['/v1/sessions']!['post']!.security).toEqual([]);
    expect(p['/v1/plans']!['post']!.security).toBeUndefined(); // inherits global bearer
  });
});
