import type { SelfUpdateService } from '../system/selfupdate.js';
import type { LogBuffer } from '../system/logs.js';
import type { Notifier } from '../notify/notifier.js';
import type { DeviceMountService } from '../system/device-mount.js';
import type { DaemonConfig } from '../config.js';
import type { ComposeRunner, DockerAdapter } from '../docker/adapter.js';
import type { PortObserver } from '../docker/ports.js';
import type { Repo } from '../state/repo.js';
import type { Clock, Ids } from '../util.js';
import type { TailscaleProvider } from '../exposure/tailscale.js';
import type { NetProvider } from '../system/net.js';
import type { PackageStore } from '../packages/store.js';
import type { GitFetcher } from '../packages/git.js';
import type { CaddyAdmin } from '../exposure/caddy.js';
import type { MachineKeyHolder } from '../auth/machine-holder.js';
import type { ApplicationService } from './service.js';
import type { CryptoProvider } from '../storage/crypto-provider.js';

// HTTPS reachability check of a published address with real certificate verification.
export type UrlVerifier = (url: string, opts?: { expectStatus?: number[]; timeoutMs?: number }) => Promise<{ ok: boolean; status: number | null; error: string | null }>;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface Ctx {
  config: DaemonConfig;
  repo: Repo;
  docker: DockerAdapter;
  compose: ComposeRunner;
  ports: PortObserver;
  clock: Clock;
  ids: Ids;
  log: Logger;
  installationId: string;
  version: string;
  tailscale: TailscaleProvider;
  caddy: CaddyAdmin;
  verify: UrlVerifier;
  net: NetProvider;
  packages: PackageStore;
  logBuffer: LogBuffer;
  selfUpdate: SelfUpdateService;
  notifier: Notifier;
  git: GitFetcher;
  // Unsealed per-installation machine key (AFU only; null in BFU). Held in
  // memory from the first login after boot; cleared on shutdown.
  machineKey: MachineKeyHolder;
  // Back-reference so the runner can consume single-use install secrets.
  // Set in daemon.ts after the service is constructed.
  service: ApplicationService;
  // Removable-device mounts (root oneshot via polkit). Set after construction
  // in daemon.ts — the observer's auto-mount uses it; null in tests/dev that
  // never wire it (auto-mount then skips quietly).
  devices?: DeviceMountService | null;
  // Per-app kernel sealing (fscrypt). Fake no-op in tests/dev; root helpers
  // on a live host. Never null after daemon wiring (defaults to fake).
  crypto?: CryptoProvider | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
export function jsonLogger(level: LogLevel, sink: (line: string, level: LogLevel) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const order = LOG_ORDER;
  const emit = (lvl: keyof typeof order, msg: string, data?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    sink(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...(data ?? {}) }), lvl);
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}
