import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { rfc3339, type Clock, type Ids } from '../util.js';

export const SCHEMA_VERSION = 11;

// Decision 126: one row per (consumer, link id). provider_instance_id NULL = needs a provider;
// 'dormant' = the consumer is removed (retained) and Reinstall re-creates the link.
const LINKS_SQL = `
CREATE TABLE links (
  consumer_instance_id TEXT NOT NULL REFERENCES instances(id),
  link_id TEXT NOT NULL,
  provider_instance_id TEXT REFERENCES instances(id),
  provider_endpoint TEXT,
  network_name TEXT NOT NULL,
  network_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active','needs_provider','dormant')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (consumer_instance_id, link_id)
);
CREATE INDEX links_provider ON links(provider_instance_id);
`;

// v11 (decision 154): one row per backup / restore / prune / check run. No foreign key on purpose:
// the history of an app outlives a purge, and a restore on a new machine starts before its instance.
const BACKUP_RUNS_SQL = `
CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  instance_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('backup','restore','prune','check')),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  state TEXT NOT NULL CHECK (state IN ('running','succeeded','partial','failed','skipped')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  downtime_ms INTEGER,
  bytes_added INTEGER,
  total_bytes INTEGER,
  message TEXT,
  operation_id TEXT,
  targets_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX backup_runs_instance ON backup_runs(instance_id, started_at);
`;

export const SCHEMA_SQL = `
CREATE TABLE installation (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  config_json TEXT NOT NULL
);
CREATE TABLE administrator (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  params_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session','remember')),
  last_seen_at TEXT
);
CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL UNIQUE,
  package_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  desired TEXT NOT NULL CHECK (desired IN ('running','stopped','retained')),
  install_state TEXT NOT NULL CHECK (install_state IN ('installing','installed','failed','needs_action','retained')),
  runtime TEXT NOT NULL CHECK (runtime IN ('running','stopped','starting','unavailable','unknown')),
  readiness TEXT NOT NULL CHECK (readiness IN ('healthy','unhealthy','checking','unknown')),
  observed_at TEXT,
  ever_installed INTEGER NOT NULL DEFAULT 0,
  release_dir TEXT NOT NULL,
  release_hashes_json TEXT NOT NULL,
  endpoints_json TEXT NOT NULL,
  secrets_json TEXT NOT NULL,
  active_operation_id TEXT,
  last_operation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  primary_exposure TEXT NOT NULL DEFAULT 'loopback' CHECK (primary_exposure IN ('loopback','tailnet','public')),
  purged_at TEXT,
  display_name TEXT,
  icon_json TEXT,
  auto_update INTEGER NOT NULL DEFAULT 0,
  primary_host TEXT
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE domains (
  hostname TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  checked_at TEXT,
  dns_state TEXT NOT NULL DEFAULT 'unknown' CHECK (dns_state IN ('points_here','points_elsewhere','no_record','unknown')),
  addresses_json TEXT NOT NULL DEFAULT '[]',
  note TEXT
);
CREATE TABLE port_claims (
  port INTEGER PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  endpoint_id TEXT NOT NULL
);
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  expected_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_operation_id TEXT
);
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL UNIQUE REFERENCES plans(id),
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  state TEXT NOT NULL CHECK (state IN ('queued','applying','verifying','succeeded','failed','needs_action')),
  phase TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  next_action TEXT,
  result_json TEXT
);
CREATE TABLE resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  kind TEXT NOT NULL CHECK (kind IN ('container','volume','network','bind')),
  role TEXT NOT NULL,
  docker_id TEXT,
  name TEXT NOT NULL,
  token TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (instance_id, kind, role)
);
CREATE TABLE events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT,
  instance_id TEXT,
  at TEXT NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX events_operation ON events(operation_id, cursor);
CREATE INDEX events_instance ON events(instance_id, cursor);
CREATE TABLE exposures (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  endpoint_id TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('tailnet','public','proxy')),
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL,
  protection TEXT NOT NULL CHECK (protection IN ('none','basic')),
  state TEXT NOT NULL CHECK (state IN ('pending','active','degraded','removing')),
  observed_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  proxy_from TEXT,
  UNIQUE (via, hostname, port)
);
CREATE INDEX exposures_instance ON exposures(instance_id, endpoint_id, via);
CREATE TABLE platform_tools (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('managed','external','absent')),
  browser_url TEXT,
  installation_state TEXT NOT NULL,
  availability TEXT NOT NULL,
  observed_at TEXT,
  note TEXT,
  resources_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  instance_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  read_at TEXT,
  delivered_at TEXT
);
CREATE INDEX notifications_unread ON notifications(read_at, created_at);
CREATE TABLE package_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('git')),
  url TEXT NOT NULL,
  ref TEXT NOT NULL,
  subpath TEXT,
  pinned_commit TEXT,
  last_seen_commit TEXT,
  auto_redeploy INTEGER NOT NULL DEFAULT 0,
  package_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  checked_at TEXT,
  note TEXT
);
${LINKS_SQL}
${BACKUP_RUNS_SQL}
`;

export type Db = Database.Database;

export function dbPath(stateDir: string): string {
  return path.join(stateDir, 'harbor.db');
}

function applyPragmas(db: Db): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

// Explicit fresh-state initialization. Refuses to run when a database already exists.
export function initializeState(stateDir: string, opts: { clock: Clock; ids: Ids; config: unknown; settings?: Record<string, unknown> }): { installationId: string } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = dbPath(stateDir);
  if (existsSync(file)) throw new HarborError('STATE_UNAVAILABLE', `state already initialized at ${file}`, { nextAction: 'Use the existing state; initialization never overwrites.' });
  for (const sub of ['instances', 'platform']) mkdirSync(path.join(stateDir, sub), { recursive: true, mode: 0o700 });
  const db = new Database(file, { fileMustExist: false });
  try {
    applyPragmas(db);
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    const installationId = opts.ids.uuid();
    db.prepare('INSERT INTO installation (id, schema_version, created_at, config_json) VALUES (?, ?, ?, ?)').run(
      installationId,
      SCHEMA_VERSION,
      rfc3339(opts.clock.now()),
      JSON.stringify(opts.config ?? {}),
    );
    // Fresh-install defaults (decision 132): written once here, so an existing installation never gets them.
    for (const [key, value] of Object.entries(opts.settings ?? {})) db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), rfc3339(opts.clock.now()));
    return { installationId };
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) chmodSync(file + suffix, 0o600);
  }
}

// Open existing state. Missing or corrupt state is an error, never a silent reset.
export function openState(stateDir: string, opts: { readonly?: boolean } = {}): Db {
  const file = dbPath(stateDir);
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) {
    throw new HarborError('STATE_UNAVAILABLE', `state not initialized: ${file} does not exist`, {
      nextAction: 'Run the explicit initialization (bootstrap or `harbor init`). Harbor never creates state implicitly.',
    });
  }
  let db: Db;
  try {
    db = new Database(file, { fileMustExist: true, readonly: opts.readonly ?? false });
  } catch (e) {
    throw new HarborError('STATE_UNAVAILABLE', `cannot open state database: ${(e as Error).message}`);
  }
  try {
    if (!opts.readonly) {
      applyPragmas(db);
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) chmodSync(file + suffix, 0o600);
    } else db.pragma('foreign_keys = ON');
    const check = db.pragma('quick_check', { simple: true }) as string;
    if (check !== 'ok') throw new HarborError('STATE_UNAVAILABLE', `state database integrity check failed: ${check}`);
    let version = db.pragma('user_version', { simple: true }) as number;
    if (version < SCHEMA_VERSION && version >= 1 && !opts.readonly) {
      db.pragma('foreign_keys = OFF'); // table rebuilds below; re-enabled right after
      try {
        if (version === 1) {
          migrateV1toV2(db);
          version = 2;
        }
        if (version === 2) {
          migrateV2toV3(db);
          version = 3;
        }
        if (version === 3) {
          migrateV3toV4(db);
          version = 4;
        }
        if (version === 4) {
          migrateV4toV5(db);
          version = 5;
        }
        if (version === 5) {
          migrateV5toV6(db);
          version = 6;
        }
        if (version === 6) {
          migrateV6toV7(db);
          version = 7;
        }
        if (version === 7) {
          migrateV7toV8(db);
          version = 8;
        }
        if (version === 8) {
          migrateV8toV9(db);
          version = 9;
        }
        if (version === 9) {
          migrateV9toV10(db);
          version = 10;
        }
        if (version === 10) {
          migrateV10toV11(db);
          version = 11;
        }
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
    if (version !== SCHEMA_VERSION) throw new HarborError('STATE_UNAVAILABLE', `state schema version ${version} is not supported (expected ${SCHEMA_VERSION})`);
    const inst = db.prepare('SELECT COUNT(*) AS n FROM installation').get() as { n: number };
    if (inst.n !== 1) throw new HarborError('STATE_UNAVAILABLE', `state database has ${inst.n} installation rows (expected 1)`);
    return db;
  } catch (e) {
    db.close();
    if (e instanceof HarborError) throw e;
    throw new HarborError('STATE_UNAVAILABLE', `state database unusable: ${(e as Error).message}`);
  }
}

// v1 -> v2: exposures table, per-instance primary exposure, plan kinds no longer constrained by CHECK.
// Runs in one transaction; existing rows are preserved verbatim.
// v5: per-installation settings (appearance, home layout) and per-app display name / custom icon.
function migrateV4toV5(db: Db): void {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE instances ADD COLUMN display_name TEXT;
      ALTER TABLE instances ADD COLUMN icon_json TEXT;
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.pragma('user_version = 5');
  })();
}

// v7: long-lived "remember this browser" sessions: kind + last-seen for rotation/visibility.
function migrateV6toV7(db: Db): void {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session','remember'));
      ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
    `);
    db.pragma('user_version = 7');
  })();
}

// v8: exposures published through the operator's own reverse proxy (decision 118): via 'proxy' and
// the address that proxy connects from (the only source whose forwarded headers the app trusts).
function migrateV7toV8(db: Db): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE exposures_v8 (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        endpoint_id TEXT NOT NULL,
        via TEXT NOT NULL CHECK (via IN ('tailnet','public','proxy')),
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL,
        protection TEXT NOT NULL CHECK (protection IN ('none','basic')),
        state TEXT NOT NULL CHECK (state IN ('pending','active','degraded','removing')),
        observed_at TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        proxy_from TEXT,
        UNIQUE (instance_id, endpoint_id, via),
        UNIQUE (via, hostname, port)
      );
      INSERT INTO exposures_v8 (id, instance_id, endpoint_id, via, hostname, port, protection, state, observed_at, note, created_at)
        SELECT id, instance_id, endpoint_id, via, hostname, port, protection, state, observed_at, note, created_at FROM exposures;
      DROP TABLE exposures;
      ALTER TABLE exposures_v8 RENAME TO exposures;
    `);
    db.pragma('user_version = 8');
  })();
}

// v9: app links (decision 126). A link is a relation between two instances (consumer -> provider), so it
// gets its own table instead of a resource row: both sides must find it, and it outlives the provider.
function migrateV8toV9(db: Db): void {
  db.transaction(() => {
    db.exec(LINKS_SQL);
    db.pragma('user_version = 9');
  })();
}

// v10: an endpoint may be published under several public hostnames (decision 127). The per-(instance,
// endpoint, via) uniqueness goes (one row per hostname; tailnet/proxy stay one per endpoint, enforced at
// plan time); each address stays unique installation-wide. instances.primary_host names the main public
// hostname (NULL = the first one published). Rows are copied in publication order.
function migrateV9toV10(db: Db): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE exposures_v10 (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        endpoint_id TEXT NOT NULL,
        via TEXT NOT NULL CHECK (via IN ('tailnet','public','proxy')),
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL,
        protection TEXT NOT NULL CHECK (protection IN ('none','basic')),
        state TEXT NOT NULL CHECK (state IN ('pending','active','degraded','removing')),
        observed_at TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        proxy_from TEXT,
        UNIQUE (via, hostname, port)
      );
      INSERT INTO exposures_v10 (id, instance_id, endpoint_id, via, hostname, port, protection, state, observed_at, note, created_at, proxy_from)
        SELECT id, instance_id, endpoint_id, via, hostname, port, protection, state, observed_at, note, created_at, proxy_from FROM exposures ORDER BY created_at, rowid;
      DROP TABLE exposures;
      ALTER TABLE exposures_v10 RENAME TO exposures;
      CREATE INDEX exposures_instance ON exposures(instance_id, endpoint_id, via);
      ALTER TABLE instances ADD COLUMN primary_host TEXT;
    `);
    db.pragma('user_version = 10');
  })();
}

function migrateV10toV11(db: Db): void {
  db.transaction(() => {
    db.exec(BACKUP_RUNS_SQL);
    db.pragma('user_version = 11');
  })();
}

// v6: notifications, git package sources, per-instance automatic updates (round 9, decision 82).
function migrateV5toV6(db: Db): void {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE instances ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        instance_id TEXT,
        dedupe_key TEXT NOT NULL UNIQUE,
        read_at TEXT,
        delivered_at TEXT
      );
      CREATE INDEX notifications_unread ON notifications(read_at, created_at);
      CREATE TABLE package_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('git')),
        url TEXT NOT NULL,
        ref TEXT NOT NULL,
        subpath TEXT,
        pinned_commit TEXT,
        last_seen_commit TEXT,
        auto_redeploy INTEGER NOT NULL DEFAULT 0,
        package_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        checked_at TEXT,
        note TEXT
      );
    `);
    db.pragma('user_version = 6');
  })();
}

// v4: full uninstall (instances.purged_at) and registered public domains.
function migrateV3toV4(db: Db): void {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE instances ADD COLUMN purged_at TEXT;
      CREATE TABLE domains (
        hostname TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        checked_at TEXT,
        dns_state TEXT NOT NULL DEFAULT 'unknown' CHECK (dns_state IN ('points_here','points_elsewhere','no_record','unknown')),
        addresses_json TEXT NOT NULL DEFAULT '[]',
        note TEXT
      );
    `);
    db.pragma('user_version = 4');
  })();
}

// v3: resources.kind accepts 'bind' (external host directories chosen at install time).
function migrateV2toV3(db: Db): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE resources_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        kind TEXT NOT NULL CHECK (kind IN ('container','volume','network','bind')),
        role TEXT NOT NULL,
        docker_id TEXT,
        name TEXT NOT NULL,
        token TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (instance_id, kind, role)
      );
      INSERT INTO resources_v3 (id, instance_id, kind, role, docker_id, name, token, metadata_json, created_at)
        SELECT id, instance_id, kind, role, docker_id, name, token, metadata_json, created_at FROM resources;
      DROP TABLE resources;
      ALTER TABLE resources_v3 RENAME TO resources;
    `);
    db.pragma('user_version = 3');
  })();
}

function migrateV1toV2(db: Db): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE exposures (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        endpoint_id TEXT NOT NULL,
        via TEXT NOT NULL CHECK (via IN ('tailnet','public')),
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL,
        protection TEXT NOT NULL CHECK (protection IN ('none','basic')),
        state TEXT NOT NULL CHECK (state IN ('pending','active','degraded','removing')),
        observed_at TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (instance_id, endpoint_id, via),
        UNIQUE (via, hostname, port)
      );
      ALTER TABLE instances ADD COLUMN primary_exposure TEXT NOT NULL DEFAULT 'loopback' CHECK (primary_exposure IN ('loopback','tailnet','public'));
      CREATE TABLE plans_v2 (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        proposal_json TEXT NOT NULL,
        expected_generation INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_operation_id TEXT
      );
      INSERT INTO plans_v2 SELECT id, actor, kind, instance_id, proposal_json, expected_generation, created_at, expires_at, consumed_operation_id FROM plans;
      DROP TABLE plans;
      ALTER TABLE plans_v2 RENAME TO plans;
    `);
    db.pragma('user_version = 2');
  })();
}
