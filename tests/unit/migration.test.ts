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
    opened.close();
    // second open: no migration, still fine
    const again = openState(dir);
    expect(again.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    again.close();
  });
});
