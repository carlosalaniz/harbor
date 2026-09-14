import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replaceReleaseFiles } from '../../src/bootstrap/bootstrap.js';

describe('bootstrap release file replacement', () => {
  it('replaces an existing release including symlinks in node_modules/.bin and drops stale files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'harbor-rel-'));
    const src = path.join(root, 'src');
    const dst = path.join(root, 'opt');
    for (const base of [src, dst]) {
      mkdirSync(path.join(base, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(path.join(base, 'dist'), { recursive: true });
      writeFileSync(path.join(base, 'node_modules', 'tool.js'), base === src ? 'new' : 'old');
      symlinkSync('../tool.js', path.join(base, 'node_modules', '.bin', 'tool'));
      writeFileSync(path.join(base, 'release.json'), JSON.stringify({ product: 'harbor', version: base === src ? '0.2.0' : '0.1.0' }));
    }
    writeFileSync(path.join(dst, 'dist', 'stale.js'), 'stale');
    writeFileSync(path.join(src, 'dist', 'daemon.js'), 'daemon');
    // second call must also be idempotent
    replaceReleaseFiles(src, dst);
    replaceReleaseFiles(src, dst);
    expect(readFileSync(path.join(dst, 'node_modules', 'tool.js'), 'utf8')).toBe('new');
    expect(readlinkSync(path.join(dst, 'node_modules', '.bin', 'tool'))).toBe('../tool.js');
    expect(JSON.parse(readFileSync(path.join(dst, 'release.json'), 'utf8')).version).toBe('0.2.0');
    expect(existsSync(path.join(dst, 'dist', 'stale.js'))).toBe(false);
    expect(readFileSync(path.join(dst, 'dist', 'daemon.js'), 'utf8')).toBe('daemon');
  });
});
