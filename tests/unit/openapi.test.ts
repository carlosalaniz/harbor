import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateOpenApi } from '../../src/api/openapi.js';

describe('OpenAPI description', () => {
  it('covers exactly the implemented routes and matches the committed document', async () => {
    const doc = await generateOpenApi();
    const paths = Object.keys(doc['paths'] as object).sort();
    expect(paths).toEqual(['/healthz', '/v1/account/password', '/v1/account/security', '/v1/account/totp/disable', '/v1/account/totp/enable', '/v1/account/totp/setup', '/v1/appearance', '/v1/appearance/home', '/v1/appearance/rotation', '/v1/appearance/rotation/next', '/v1/appearance/wallpaper', '/v1/catalog', '/v1/catalog/{id}/asset/{name}', '/v1/domains', '/v1/domains/{hostname}', '/v1/domains/{hostname}/check', '/v1/exposures', '/v1/found-apps', '/v1/found-apps/adopt', '/v1/host/devices/{name}/mount', '/v1/host/devices/{name}/status', '/v1/host/devices/{name}/unmount', '/v1/host/folders', '/v1/host/storage', '/v1/host/storage/policy', '/v1/instances', '/v1/instances/{id}', '/v1/instances/{id}/adopt-drive', '/v1/instances/{id}/appearance', '/v1/instances/{id}/auto-update', '/v1/instances/{id}/icon', '/v1/instances/{id}/logs', '/v1/instances/{id}/widget', '/v1/logs/harbor', '/v1/notifications', '/v1/notifications/channels', '/v1/notifications/channels/test', '/v1/notifications/read-all', '/v1/notifications/{id}/read', '/v1/operations', '/v1/operations/{id}', '/v1/package-sources', '/v1/package-sources/{id}', '/v1/package-sources/{id}/auto-redeploy', '/v1/package-sources/{id}/check', '/v1/packages', '/v1/packages/{id}', '/v1/plans', '/v1/plans/{id}', '/v1/platform-tools', '/v1/platform-tools/tailscale/login', '/v1/platform-tools/tailscale/logout', '/v1/platform-tools/{id}', '/v1/platform-tools/{id}/install', '/v1/sessions', '/v1/sessions/current', '/v1/sessions/others', '/v1/setup', '/v1/system', '/v1/system/host', '/v1/system/metrics', '/v1/system/name', '/v1/system/power', '/v1/system/storage/usage', '/v1/system/update', '/v1/system/update/apply', '/v1/system/update/check', '/v1/ui-exposure', '/v1/updates/apply-all', '/v1/updates/policy']);
    const committed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../docs/openapi.json'), 'utf8'));
    expect(committed.paths).toEqual(doc['paths']);
    // Login and liveness are the only unauthenticated routes.
    const p = doc['paths'] as Record<string, Record<string, { security?: unknown[] }>>;
    expect(p['/healthz']!['get']!.security).toEqual([]);
    expect(p['/v1/sessions']!['post']!.security).toEqual([]);
    expect(p['/v1/catalog/{id}/asset/{name}']!['get']!.security).toEqual([]); // <img src> cannot send a bearer token
    expect(p['/v1/plans']!['post']!.security).toBeUndefined(); // inherits global bearer
  });
});
