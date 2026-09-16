import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { loadConfig } from '../config.js';
import { openState } from '../state/db.js';
import { Repo } from '../state/repo.js';
import { acquireLock } from '../state/lock.js';
import { gatherHostFacts } from './host.js';
import { rfc3339, systemClock } from '../util.js';
import { exec } from './exec.js';
import { setupCockpit, setupPortainer } from './tools.js';

// The root half of a one-click platform-tool install from the console
// (run by harbor-tools-install@<tool>.service). Reuses the bootstrap recipes
// (setupCockpit / setupPortainer), records the result in state, and writes
// progress to <stateDir>/platform/<tool>/install-status.json so the console
// can poll it. Must run as root (started by the template unit).
export type ToolInstallState = 'requested' | 'installing' | 'succeeded' | 'failed';
export interface ToolInstallStatus {
  tool: string;
  state: ToolInstallState;
  message: string;
  at: string;
}

export function toolInstallStatusFile(stateDir: string, tool: string): string {
  return path.join(stateDir, 'platform', tool, 'install-status.json');
}

function writeStatus(stateDir: string, tool: string, state: ToolInstallState, message: string): void {
  const file = toolInstallStatusFile(stateDir, tool);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ tool, state, message, at: new Date().toISOString() }), { mode: 0o600 });
  } catch {
    /* status is best effort */
  }
}

export function readToolInstallStatus(stateDir: string, tool: string): ToolInstallStatus | null {
  try {
    const file = toolInstallStatusFile(stateDir, tool);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as ToolInstallStatus;
  } catch {
    return null;
  }
}

export async function applyToolInstall(tool: string, log: (m: string) => void): Promise<void> {
  if (tool !== 'cockpit' && tool !== 'portainer') throw new HarborError('INVALID_REQUEST', `unknown platform tool ${tool} (expected cockpit or portainer)`);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'tools-install must run as root (it is started by harbor-tools-install@.service)');
  const config = loadConfig(`${PRODUCT.paths.etc}/harbor.json`);
  const stateDir = config.stateDir;
  writeStatus(stateDir, tool, 'installing', `installing ${tool}`);
  log(`installing ${tool}`);
  try {
    const facts = await gatherHostFacts();
    const now = rfc3339(systemClock.now());
    const record =
      tool === 'cockpit'
        ? await setupCockpit(log, facts.existing.cockpit, now)
        : await setupPortainer(log, new Repo(openState(stateDir), systemClock).installation().id, facts.docker.binary!, facts.docker.socket, stateDir, facts.existing.portainer.containerPresent, now);
    const lock = acquireLock(stateDir, 'bootstrap-tools');
    try {
      const db = openState(stateDir);
      const repo = new Repo(db, systemClock);
      const prev = repo.platformTool(record.id);
      repo.upsertPlatformTool({ ...record, resources: prev?.resources || record.resources ? { ...(prev?.resources ?? {}), ...(record.resources ?? {}) } : null });
      db.close();
    } finally {
      lock.release();
    }
    // fix ownership: the root step wrote state files the harbor user must own
    const uid = Number((await exec('/usr/bin/id', ['-u', PRODUCT.serviceUser])).stdout.trim());
    const gid = Number((await exec('/usr/bin/id', ['-g', PRODUCT.serviceUser])).stdout.trim());
    await exec('/usr/bin/chown', ['-R', `${uid}:${gid}`, path.join(stateDir, 'platform')]);
    writeStatus(stateDir, tool, 'succeeded', `${tool} installed`);
    log(`done: ${tool} installed`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeStatus(stateDir, tool, 'failed', msg);
    log(`failed: ${msg}`);
    throw e;
  }
}
