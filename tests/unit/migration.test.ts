import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openState, SCHEMA_VERSION } from '../../src/state/db.js';

// The v1 schema as shipped in the MVP (tag v0.1.0-mvp), reduced to the tables the migration touches.
const V1 = `
CREATE TABLE installation (id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL, config_json TEXT NOT NULL);
CREATE TABLE administrator (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, params_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, actor TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE instances (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, project TEXT NOT NULL UNIQUE, package_id TEXT NOT NULL, revision TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
  desired TEXT NOT NULL, install_state TEXT NOT NULL, runtime TEXT NOT NULL, readiness TEXT NOT NULL, observed_at TEXT, ever_installed INTEGER NOT NULL DEFAULT 0, release_dir TEXT NOT NULL,
  release_hashes_json TEXT NOT NULL, endpoints_json TEXT NOT NULL, secrets_json TEXT NOT NULL, active_operation_id TEXT, last_operation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE port_claims (port INTEGER PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(id), endpoint_id TEXT NOT NULL);
CREATE TABLE plans (id TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('install','start','stop','remove','reinstall')), instance_id TEXT NOT NULL, proposal_json TEXT NOT NULL, expected_generation INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_operation_id TEXT);
CREATE TABLE operations (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL UNIQUE REFERENCES plans(id), actor TEXT NOT NULL, kind TEXT NOT NULL, instance_id TEXT NOT NULL REFERENCES instances(id), state TEXT NOT NULL, phase TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error_code TEXT, error_message TEXT, next_action TEXT, result_json TEXT);
CREATE TABLE resources (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL REFERENCES instances(id), kind TEXT NOT NULL, role TEXT NOT NULL, docker_id TEXT, name TEXT NOT NULL, token TEXT, metadata_json TEXT, created_at TEXT NOT NULL, UNIQUE (instance_id, kind, role));
CREATE TABLE events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT, instance_id TEXT, at TEXT NOT NULL, phase TEXT NOT NULL, message TEXT NOT NULL);
CREATE TABLE platform_tools (id TEXT PRIMARY KEY, mode TEXT NOT NULL, browser_url TEXT, installation_state TEXT NOT NULL, availability TEXT NOT NULL, observed_at TEXT, note TEXT, resources_json TEXT, updated_at TEXT NOT NULL);
`;

describe('state migration v1 -> v2', () => {
  it('adds exposures and primary_exposure, keeps plans/operations rows and their relationship', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-mig-'));
    const db = new Database(path.join(dir, 'harbor.db'));
    db.exec(V1);
    db.pragma('user_version = 1');
    db.prepare("INSERT INTO installation VALUES ('11111111-1111-4111-8111-111111111111', 1, '2026-01-01T00:00:00Z', '{}')").run();
    db.prepare(`INSERT INTO instances (id, name, project, package_id, revision, desired, install_state, runtime, readiness, release_dir, release_hashes_json, endpoints_json, secrets_json, created_at, updated_at)
      VALUES ('22222222-2222-4222-8222-222222222222', 'excalidraw', 'hb_x', 'excalidraw', '1', 'running', 'installed', 'running', 'healthy', 'instances/x/release', '{}', '[]', '[]', 't', 't')`).run();
    db.prepare("INSERT INTO plans VALUES ('33333333-3333-4333-8333-333333333333', 'admin', 'install', '22222222-2222-4222-8222-222222222222', '{}', 0, 't', 't', '44444444-4444-4444-8444-444444444444')").run();
    db.prepare("INSERT INTO operations (id, idempotency_key, plan_id, actor, kind, instance_id, state, phase, created_at) VALUES ('44444444-4444-4444-8444-444444444444', 'k', '33333333-3333-4333-8333-333333333333', 'admin', 'install', '22222222-2222-4222-8222-222222222222', 'succeeded', 'succeeded', 't')").run();
    db.close();

    const opened = openState(dir);
    expect(opened.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(opened.prepare('SELECT COUNT(*) AS n FROM exposures').get()).toEqual({ n: 0 });
    expect(opened.prepare('SELECT primary_exposure FROM instances').get()).toEqual({ primary_exposure: 'loopback' });
    expect(opened.prepare('SELECT kind FROM plans').get()).toEqual({ kind: 'install' });
    // plan kinds beyond the v1 CHECK are accepted now
    opened.prepare("INSERT INTO plans VALUES ('55555555-5555-4555-8555-555555555555', 'admin', 'expose', '22222222-2222-4222-8222-222222222222', '{}', 1, 't', 't', NULL)").run();
    expect((opened.prepare('SELECT COUNT(*) AS n FROM operations o JOIN plans p ON p.id = o.plan_id').get() as { n: number }).n).toBe(1);
    expect(opened.pragma('foreign_key_check')).toEqual([]);
    // v5: settings table and per-app look columns
    opened.prepare("INSERT INTO settings VALUES ('home.order', '[]', 't')").run();
    expect(opened.prepare('SELECT display_name, icon_json FROM instances').get()).toEqual({ display_name: null, icon_json: null });
    // v6: notifications (dedupe unique), package sources, per-instance auto-update default off
    expect(opened.prepare('SELECT auto_update FROM instances').get()).toEqual({ auto_update: 0 });
    opened.prepare("INSERT INTO notifications (id, created_at, kind, severity, title, body, dedupe_key) VALUES ('66666666-6666-4666-8666-666666666666', 't', 'update', 'info', 'Update', 'b', 'update:x:2')").run();
    expect(() => opened.prepare("INSERT INTO notifications (id, created_at, kind, severity, title, body, dedupe_key) VALUES ('77777777-7777-4777-8777-777777777777', 't', 'update', 'info', 'Update', 'b', 'update:x:2')").run()).toThrow(/UNIQUE/);
    opened.prepare("INSERT INTO package_sources (id, kind, url, ref, package_id, created_at) VALUES ('88888888-8888-4888-8888-888888888888', 'git', 'https://github.com/x/y', 'main', 'myapp', 't')").run();
    // v8: exposures through the operator's own proxy carry the proxy's address
    opened.prepare("INSERT INTO exposures (id, instance_id, endpoint_id, via, hostname, port, protection, state, note, created_at, proxy_from) VALUES ('99999999-9999-4999-8999-999999999999', '22222222-2222-4222-8222-222222222222', 'web', 'proxy', 'cloud.example.com', 443, 'none', 'active', NULL, 't', '192.168.0.20')").run();
    expect(opened.prepare('SELECT via, proxy_from FROM exposures').get()).toEqual({ via: 'proxy', proxy_from: '192.168.0.20' });
    expect(() => opened.prepare("INSERT INTO exposures (id, instance_id, endpoint_id, via, hostname, port, protection, state, created_at) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'web', 'carrier-pigeon', 'x', 1, 'none', 'active', 't')").run()).toThrow(/CHECK/);
    // v9: app links (decision 126), one row per (consumer, link id); provider null = needs a provider
    opened.prepare("INSERT INTO links (consumer_instance_id, link_id, provider_instance_id, provider_endpoint, network_name, state, created_at, updated_at) VALUES ('22222222-2222-4222-8222-222222222222', 'docs', NULL, NULL, 'hb_x_link_docs', 'needs_provider', 't', 't')").run();
    expect(opened.prepare('SELECT link_id, state, network_id FROM links').get()).toEqual({ link_id: 'docs', state: 'needs_provider', network_id: null });
    expect(() => opened.prepare("INSERT INTO links (consumer_instance_id, link_id, network_name, state, created_at, updated_at) VALUES ('22222222-2222-4222-8222-222222222222', 'docs', 'n', 'active', 't', 't')").run()).toThrow(/UNIQUE|PRIMARY/);
    expect(() => opened.prepare("INSERT INTO links (consumer_instance_id, link_id, network_name, state, created_at, updated_at) VALUES ('22222222-2222-4222-8222-222222222222', 'other', 'n', 'sleeping', 't', 't')").run()).toThrow(/CHECK/);
    expect(opened.pragma('foreign_key_check')).toEqual([]);
    opened.close();
    // second open: no migration, still fine
    const again = openState(dir);
    expect(again.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    again.close();
  });
});

describe('state migration v9 -> v10 (decision 127)', () => {
  it('keeps every exposure in publication order, allows several public names per endpoint, keeps addresses unique, adds primary_host', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-mig10-'));
    const db = new Database(path.join(dir, 'harbor.db'));
    db.exec(V1);
    db.pragma('user_version = 1');
    db.prepare("INSERT INTO installation VALUES ('11111111-1111-4111-8111-111111111111', 1, '2026-01-01T00:00:00Z', '{}')").run();
    db.prepare(`INSERT INTO instances (id, name, project, package_id, revision, desired, install_state, runtime, readiness, release_dir, release_hashes_json, endpoints_json, secrets_json, created_at, updated_at)
      VALUES ('22222222-2222-4222-8222-222222222222', 'erp', 'hb_e', 'erp', '1', 'running', 'installed', 'running', 'healthy', 'instances/e/release', '{}', '[]', '[]', 't', 't')`).run();
    db.close();
    // Bring it to the current schema, then rebuild the v9 shape of the two tables v10 touches.
    openState(dir).close();
    const v9 = new Database(path.join(dir, 'harbor.db'));
    v9.pragma('foreign_keys = OFF');
    v9.exec(`
      DROP TABLE exposures;
      CREATE TABLE exposures (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(id), endpoint_id TEXT NOT NULL, via TEXT NOT NULL CHECK (via IN ('tailnet','public','proxy')), hostname TEXT NOT NULL, port INTEGER NOT NULL, protection TEXT NOT NULL CHECK (protection IN ('none','basic')), state TEXT NOT NULL CHECK (state IN ('pending','active','degraded','removing')), observed_at TEXT, note TEXT, created_at TEXT NOT NULL, proxy_from TEXT, UNIQUE (instance_id, endpoint_id, via), UNIQUE (via, hostname, port));
      ALTER TABLE instances DROP COLUMN primary_host;
    `);
    v9.prepare("INSERT INTO exposures (id, instance_id, endpoint_id, via, hostname, port, protection, state, created_at) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'web', 'public', 'erp.example.com', 443, 'basic', 'active', '2026-10-01T00:00:00Z')").run();
    v9.prepare("INSERT INTO exposures (id, instance_id, endpoint_id, via, hostname, port, protection, state, created_at, proxy_from) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'web', 'proxy', 'lan.example.net', 443, 'none', 'active', '2026-09-01T00:00:00Z', '192.0.2.20')").run();
    expect(() => v9.prepare("INSERT INTO exposures (id, instance_id, endpoint_id, via, hostname, port, protection, state, created_at) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222', 'web', 'public', 'customers.example.org', 443, 'none', 'active', 't')").run()).toThrow(/UNIQUE/);
    v9.pragma('user_version = 9');
    v9.close();

    const opened = openState(dir);
    expect(opened.pragma('user_version', { simple: true })).toBe(10);
    expect(opened.prepare('SELECT id, via, hostname, protection, proxy_from FROM exposures ORDER BY rowid').all()).toEqual([
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', via: 'proxy', hostname: 'lan.example.net', protection: 'none', proxy_from: '192.0.2.20' },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', via: 'public', hostname: 'erp.example.com', protection: 'basic', proxy_from: null },
    ]);
    expect(opened.prepare('SELECT primary_host FROM instances').get()).toEqual({ primary_host: null });
    // a second public name for the same endpoint is fine now; the same address twice still is not
    opened.prepare("INSERT INTO exposures (id, instance_id, endpoint_id, via, hostname, port, protection, state, created_at) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222', 'web', 'public', 'customers.example.org', 443, 'none', 'active', 't')").run();
    expect(() => opened.prepare("INSERT INTO exposures (id, instance_id, endpoint_id, via, hostname, port, protection, state, created_at) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '22222222-2222-4222-8222-222222222222', 'web', 'public', 'erp.example.com', 443, 'none', 'active', 't')").run()).toThrow(/UNIQUE/);
    expect(opened.pragma('foreign_key_check')).toEqual([]);
    opened.close();
  });
});

// Decision 132: fresh-install defaults are written once, at initialization; migrations never add them.
describe('fresh-install settings', () => {
  it('seeds the picture of the day on a new state, and only there', async () => {
    const { initializeState } = await import('../../src/state/db.js');
    const { FRESH_INSTALL_SETTINGS } = await import('../../src/maintenance.js');
    const { systemClock, systemIds } = await import('../../src/util.js');
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-fresh-'));
    initializeState(dir, { clock: systemClock, ids: systemIds, config: {}, settings: FRESH_INSTALL_SETTINGS });
    const db = openState(dir);
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'appearance.rotation'").get() as { value_json: string };
    expect(JSON.parse(row.value_json)).toEqual({ enabled: true, source: 'bing', everyHours: 24 });
    db.close();
    const bare = mkdtempSync(path.join(tmpdir(), 'harbor-bare-'));
    initializeState(bare, { clock: systemClock, ids: systemIds, config: {} });
    const db2 = openState(bare);
    expect(db2.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 });
    db2.close();
  });
});
