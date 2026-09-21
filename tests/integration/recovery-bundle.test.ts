import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openState } from '../../src/state/db.js';
import { Repo } from '../../src/state/repo.js';
import { addAppHomeManifests, collectRecoveryFiles, openRecoveryBundle, restoreRecoveryFiles, sealRecoveryBundle } from '../../src/storage/recovery-bundle.js';
import { systemClock } from '../../src/util.js';
import { tempDir } from '../unit/helpers.js';
import { startHarness, type Harness } from './harness.js';

// Recovery bundle against a live state dir: install one app, export the
// bundle, restore it over a fresh dir, and prove the fresh DB opens with the
// instance, the sealed machine key, and the secrets intact.
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

describe('recovery bundle round-trip', () => {
  it('exports live state and restores it onto a fresh dir', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'backupme', location: { dir: path.join(h.userDataDir, 'harbor-apps', 'excalidraw') } });
    const sub = await h.api.submit(plan.id, 'recovery-roundtrip-1');
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');

    // Export while the daemon is idle (no operation running): the DB file +
    // WAL sidecars copy together and replay on first open of the restore.
    const files = collectRecoveryFiles(h.stateDir);
    expect(files.has('harbor.db')).toBe(true);
    // Excalidraw declares no secrets; the release snapshot is the per-instance
    // payload that must travel (reinstall needs it).
    const releaseKeys = [...files.keys()].filter((k) => k.includes('/release/'));
    expect(releaseKeys.length).toBeGreaterThan(0);
    const { existsSync: exists, readFileSync: read } = await import('node:fs');
    const homes: { home: string; manifest: Buffer }[] = [];
    const dbProbe = openState(h.stateDir, { readonly: true });
    try {
      const repo = new Repo(dbProbe, systemClock);
      for (const inst of repo.listInstances()) {
        const home = repo.resources(inst.id).find((r) => r.kind === 'volume' && r.role === '__home__');
        if (home && exists(`${home.name}/manifest.json`)) homes.push({ home: home.name, manifest: read(`${home.name}/manifest.json`) });
      }
    } finally {
      dbProbe.close();
    }
    addAppHomeManifests(files, homes);
    expect(homes.length).toBe(1);

    const bundle = await sealRecoveryBundle(files, 'correct horse recovery');
    expect(bundle.includes(Buffer.from('backupme'))).toBe(false);
    const opened = await openRecoveryBundle(bundle, 'correct horse recovery');

    const fresh = path.join(tempDir('harbor-recovery-it-'), 'state');
    const r = restoreRecoveryFiles(fresh, opened);
    expect(r.instances).toBe(1);
    expect(r.secrets).toBe(0);
    expect(r.appHomes).toBe(1);
    expect(existsSync(path.join(fresh, 'harbor.db'))).toBe(true);

    const db = openState(fresh);
    try {
      const repo = new Repo(db, systemClock);
      const instances = repo.listInstances();
      expect(instances.map((i) => i.name)).toContain('backupme');
      // The sealed machine key travels in settings: data-folder apps unlock
      // silently after restore on the same password.
      expect(repo.setting('security.machineKey')).not.toBeNull();
      expect(repo.administrator()?.username).toBe('admin');
    } finally {
      db.close();
    }
  });
});
