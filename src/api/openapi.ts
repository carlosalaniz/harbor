import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../config.js';
import { buildApi } from './server.js';
import type { ApplicationService } from '../lifecycle/service.js';
import type { SessionService } from '../auth/sessions.js';
import type { PlatformToolsService } from '../tools/service.js';
import type { AppearanceService } from '../appearance/service.js';
import type { PowerControl } from '../system/power.js';

// Generate the OpenAPI document from the real route schemas. Handlers are never invoked.
export async function generateOpenApi(version = '0.0.0-doc'): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(path.join(tmpdir(), 'harbor-openapi-'));
  try {
    const config = normalizeConfig({ stateDir: dir, catalogDir: dir, docker: { mode: 'fake' }, listen: { host: '127.0.0.1', port: 18000 } }, dir);
    const noop = { debug() {}, info() {}, warn() {}, error() {} };
    const app = await buildApi({ config, service: {} as ApplicationService, sessions: {} as SessionService, tools: {} as PlatformToolsService, appearance: {} as AppearanceService, power: {} as PowerControl, log: noop, version });
    await app.ready();
    const doc = app.swagger() as Record<string, unknown>;
    await app.close();
    return doc;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
