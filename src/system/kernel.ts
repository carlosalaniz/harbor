// Android's binder driver for apps with the `binder` permission (decision 193). The daemon never loads a kernel
// module: it reads whether binder is there (no root: /proc/filesystems, /sys/module, modules.dep) and, when it is
// only available, blocks on `systemctl start harbor-kernel@binder.service` (polkit lets the harbor user start that
// template only). The root step (bootstrap/kernel-apply.ts) loads binder_linux and keeps it loaded at every boot.
// Harbor never installs an OS package: a kernel without the module is KERNEL_MODULE_MISSING with the apt line.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { systemctlStartBlocking } from '../storage/crypto-provider.js';

export const KERNEL_UNIT_PREFIX = 'harbor-kernel@';
export const KERNEL_UNIT_FILE = 'harbor-kernel@.service';
export const KERNEL_MODULES = ['binder'] as const;
export type KernelModule = (typeof KERNEL_MODULES)[number];

// what redroid (and Waydroid) expect: binderfs plus the three classic device nodes
export const BINDER = {
  module: 'binder_linux',
  options: 'devices=binder,hwbinder,vndbinder',
  loadFile: '/etc/modules-load.d/harbor-binder.conf',
  optionsFile: '/etc/modprobe.d/harbor-binder.conf',
} as const;

export function kernelUnit(name: KernelModule): string {
  return `${KERNEL_UNIT_PREFIX}${name}.service`;
}
export function parseKernelModule(v: string): KernelModule {
  if (!(KERNEL_MODULES as readonly string[]).includes(v)) throw new HarborError('INVALID_REQUEST', `kernel-step expects one of ${KERNEL_MODULES.join(', ')}, got ${v}`);
  return v as KernelModule;
}
export function kernelStatusFile(stateDir: string, name: KernelModule): string {
  return path.join(stateDir, 'kernel', `${name}-status.json`);
}
export function binderInstallHint(kernelRelease: string): string {
  return `sudo apt install linux-modules-extra-${kernelRelease}`;
}

// The two files the root step writes (pure; the marker says Harbor owns them)
export function binderLoadConf(): string {
  return `# Harbor: Android's binder driver for apps that ask for it (decision 193)\n${BINDER.module}\n`;
}
export function binderOptionsConf(): string {
  return `# Harbor: Android's binder driver for apps that ask for it (decision 193)\noptions ${BINDER.module} ${BINDER.options}\n`;
}

// loaded = the kernel has binderfs now; available = the module is on disk for the running kernel; missing = neither
export type BinderState = 'loaded' | 'available' | 'missing';

// Pure over a root directory (tests pass a fixture tree): never throws
export function readBinderState(root: string, kernelRelease: string): BinderState {
  const at = (p: string) => path.join(root, p);
  try {
    if (/\sbinder$/m.test(readFileSync(at('/proc/filesystems'), 'utf8'))) return 'loaded';
  } catch {
    /* no procfs: fall through */
  }
  if (existsSync(at('/sys/module/binder_linux'))) return 'loaded';
  try {
    const dep = readFileSync(at(`/lib/modules/${kernelRelease}/modules.dep`), 'utf8');
    if (/(^|\/)binder_linux\.ko(\.(zst|xz|gz))?:/m.test(dep)) return 'available';
  } catch {
    /* no module index for this kernel */
  }
  return 'missing';
}

export interface KernelStatusFile {
  module: KernelModule;
  state: 'ok' | 'missing' | 'failed';
  message: string;
  at: string;
}

export interface KernelProvider {
  readonly kind: 'fake' | 'root';
  kernelRelease(): string;
  binder(): BinderState;
  // makes binder loaded (and keeps it loaded at boot); throws KERNEL_MODULE_MISSING or OPERATION_FAILED
  loadBinder(): Promise<void>;
}

function missingError(kernelRelease: string): HarborError {
  return new HarborError('KERNEL_MODULE_MISSING', `this machine's kernel (${kernelRelease}) has no binder driver (binder_linux)`, {
    nextAction: `Install the kernel's extra modules (${binderInstallHint(kernelRelease)}), then try again. Harbor never installs system packages itself.`,
  });
}

export class RootKernelProvider implements KernelProvider {
  readonly kind = 'root' as const;
  constructor(
    private readonly stateDir: string,
    private readonly startUnit: (unit: string, timeoutMs: number) => Promise<void> = systemctlStartBlocking,
    private readonly root = '/',
  ) {}
  kernelRelease(): string {
    return release();
  }
  binder(): BinderState {
    return readBinderState(this.root, this.kernelRelease());
  }
  async loadBinder(): Promise<void> {
    const state = this.binder();
    if (state === 'loaded') return;
    if (state === 'missing') throw missingError(this.kernelRelease());
    const status = kernelStatusFile(this.stateDir, 'binder');
    // harbor owns the folder, so the daemon can read what root writes into it
    mkdirSync(path.dirname(status), { recursive: true, mode: 0o700 });
    rmSync(status, { force: true });
    let unitError: string | null = null;
    try {
      await this.startUnit(kernelUnit('binder'), 60_000);
    } catch (e) {
      unitError = e instanceof Error ? e.message : String(e);
    }
    if (this.binder() === 'loaded') return;
    let verdict: KernelStatusFile | null;
    try {
      verdict = JSON.parse(readFileSync(status, 'utf8')) as KernelStatusFile;
    } catch {
      verdict = null;
    }
    if (verdict?.state === 'missing') throw missingError(this.kernelRelease());
    throw new HarborError('OPERATION_FAILED', `the binder driver did not load: ${verdict?.message ?? unitError ?? 'no verdict from the root step'}`, {
      nextAction: `Check the journal of ${kernelUnit('binder')} (journalctl -u ${kernelUnit('binder')}), then try again.`,
    });
  }
}

// Fake mode (tests, `pnpm dev`): HARBOR_DEV_BINDER=missing|loaded, default available
export class FakeKernelProvider implements KernelProvider {
  readonly kind = 'fake' as const;
  loads = 0;
  constructor(public state: BinderState = 'available') {}
  kernelRelease(): string {
    return '6.8.0-fake-generic';
  }
  binder(): BinderState {
    return this.state;
  }
  async loadBinder(): Promise<void> {
    if (this.state === 'loaded') return;
    if (this.state === 'missing') throw missingError(this.kernelRelease());
    this.loads++;
    this.state = 'loaded';
  }
}
