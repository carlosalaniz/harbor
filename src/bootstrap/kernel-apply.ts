// The root half of the `binder` permission (decision 193), run by harbor-kernel@<module>.service. Re-checks the
// module on disk, writes Harbor's modules-load.d + modprobe.d files (so binder is loaded again at every boot, before
// Docker starts any container) and loads it now. Never installs a package: a kernel without the module reports
// `missing` and the daemon tells the operator which package to install.
import { release } from 'node:os';
import { writeFileSync } from 'node:fs';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { loadConfig } from '../config.js';
import { BINDER, binderInstallHint, binderLoadConf, binderOptionsConf, kernelStatusFile, parseKernelModule, readBinderState, type KernelStatusFile } from '../system/kernel.js';
import { exec } from './exec.js';
import { writeStatusFile } from './safe-write.js';

export const MODPROBE_BIN = '/usr/sbin/modprobe';

export async function applyKernelStep(name: string, log: (m: string) => void): Promise<void> {
  const module = parseKernelModule(name);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'kernel-step must run as root (it is started by harbor-kernel@.service)');
  const stateDir = loadConfig(`${PRODUCT.paths.etc}/harbor.json`).stateDir;
  const report = (state: KernelStatusFile['state'], message: string) => {
    try {
      // the folder is the daemon's (it made it before starting this unit); 0644 so it can read the verdict
      writeStatusFile(stateDir, kernelStatusFile(stateDir, module), JSON.stringify({ module, state, message, at: new Date().toISOString() }), { mode: 0o644 });
    } catch {
      /* the verdict is best effort; the daemon re-reads the kernel itself */
    }
    log(`${state}: ${message}`);
  };
  const rel = release();
  const state = readBinderState('/', rel);
  if (state === 'missing') {
    report('missing', `${BINDER.module} is not available for kernel ${rel}; install it with: ${binderInstallHint(rel)}`);
    throw new HarborError('KERNEL_MODULE_MISSING', `${BINDER.module} is not available for kernel ${rel}`);
  }
  try {
    writeFileSync(BINDER.optionsFile, binderOptionsConf(), { mode: 0o644 });
    writeFileSync(BINDER.loadFile, binderLoadConf(), { mode: 0o644 });
    if (state !== 'loaded') await exec(MODPROBE_BIN, [BINDER.module], { timeoutMs: 30_000 });
    if (readBinderState('/', rel) !== 'loaded') throw new Error(`${BINDER.module} loaded but the kernel has no binder file system`);
    report('ok', `${BINDER.module} is loaded and loads again at every boot`);
  } catch (e) {
    report('failed', e instanceof Error ? e.message : String(e));
    throw e;
  }
}
