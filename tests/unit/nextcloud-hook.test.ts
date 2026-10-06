import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPackage } from '../../src/packages/catalog.js';
import { REPO_CATALOG } from './helpers.js';

// The bundled Nextcloud after-start hook, run by `sh` against a stub `php occ` that records every call.
// Proves the Nextcloud Office step: re-activate the built-in CODE server on every run, leave an external
// Collabora alone, and never fail the hook when the step errors.
function runHook(opts: { wopi: string; activateExit?: number; codeEnabled?: boolean }): { status: number; stdout: string; calls: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), 'harbor-nc-hook-'));
  const log = path.join(dir, 'calls.log');
  const php = path.join(dir, 'php');
  writeFileSync(
    php,
    `#!/bin/sh
shift
echo "$*" >> "${log}"
case "$*" in
  "status") echo "  - installed: true" ;;
  "config:app:get harbor recommended") echo done ;;
  "config:app:get richdocuments enabled") echo yes ;;
  "config:app:get richdocumentscode enabled") echo "${opts.codeEnabled === false ? 'no' : 'yes'}" ;;
  "config:app:get richdocuments wopi_url") printf '%s\\n' "${opts.wopi}" ;;
  "richdocuments:activate-config") echo "activated"; exit ${opts.activateExit ?? 0} ;;
esac
exit 0
`,
  );
  chmodSync(php, 0o755);
  writeFileSync(log, '');
  const script = loadPackage(REPO_CATALOG, 'nextcloud').manifest.hooks!.afterStart!.command[2]!.replace('cd /var/www/html', `cd "${dir}"`);
  let status = 0;
  let stdout: string;
  try {
    stdout = execFileSync('sh', ['-c', script], { env: { PATH: `${dir}:/usr/bin:/bin`, HARBOR_ADDRESSES: 'cloud.example.com', HARBOR_PROXIES: '172.18.0.1', HARBOR_URL: 'https://cloud.example.com/' }, encoding: 'utf8' });
  } catch (e) {
    const err = e as { status: number; stdout: string };
    status = err.status;
    stdout = err.stdout;
  }
  return { status, stdout, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

describe('bundled Nextcloud hook: Nextcloud Office follows the main address', () => {
  it('re-activates the built-in CODE server on every run (empty or CODE proxy wopi_url), quietly', () => {
    for (const wopi of ['', 'http://localhost:18080/custom_apps/richdocumentscode/proxy.php?req=']) {
      const r = runHook({ wopi });
      expect(r.status).toBe(0);
      expect(r.calls).toContain('richdocuments:activate-config');
      expect(r.stdout).not.toContain('activated');
      // after the main address is written, so activation sees the new URL
      expect(r.calls.indexOf('richdocuments:activate-config')).toBeGreaterThan(r.calls.indexOf('config:system:set overwrite.cli.url --value=https://cloud.example.com'));
    }
  });
  it('leaves an external Collabora the operator set alone, and skips when CODE is not enabled', () => {
    expect(runHook({ wopi: 'https://office.example.com' }).calls).not.toContain('richdocuments:activate-config');
    expect(runHook({ wopi: '', codeEnabled: false }).calls).not.toContain('richdocuments:activate-config');
  });
  it('never fails the hook when activation errors: one line, exit 0', () => {
    const r = runHook({ wopi: '', activateExit: 1 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Nextcloud Office could not be pointed at the current address yet');
  });
});
