// Record a live qualification result in each package's release.json (editorial step after a
// successful `pnpm test:vm -- --fresh` run). Usage:
//   pnpm tsx scripts/catalog-qualify.ts <evidence-dir> passed|blocked
// Reads versions from the run's report.json and refreshes file hashes.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RELEASE_FILES } from '../src/contracts/release.schema.js';
import { sha256Hex } from '../src/packages/inventory.js';

const [evidenceDir, status] = process.argv.slice(2);
if (!evidenceDir || !['passed', 'blocked'].includes(status ?? '')) {
  console.error('usage: catalog-qualify.ts <docs/evidence/vm-...> passed|blocked');
  process.exit(2);
}
const report = JSON.parse(readFileSync(path.join(evidenceDir, 'report.json'), 'utf8')) as { results: { id: string; status: string; details: Record<string, unknown> }[] };
const a01 = report.results.find((r) => r.id === 'A01');
const versions = (a01?.details['versions'] ?? {}) as Record<string, string>;
const passed = report.results.filter((r) => r.status === 'pass').map((r) => r.id).sort();
const index = JSON.parse(readFileSync('catalog/index.json', 'utf8')) as { packages: Record<string, { dir: string }> };
for (const [id, entry] of Object.entries(index.packages)) {
  const dir = path.join('catalog', entry.dir);
  const releasePath = path.join(dir, 'release.json');
  const release = JSON.parse(readFileSync(releasePath, 'utf8'));
  release.qualification = {
    status,
    date: new Date().toISOString().slice(0, 10),
    node: versions['node'] ?? release.qualification?.node,
    dockerEngine: versions['docker'] ?? release.qualification?.dockerEngine,
    dockerCompose: versions['compose'] ?? release.qualification?.dockerCompose,
    hostOs: `${versions['ubuntu'] ?? 'Ubuntu 24.04'} ${versions['arch'] ?? 'x86_64'}`.trim(),
    appVersions: Object.fromEntries(Object.entries(release.images as Record<string, { appVersion?: string; tag: string }>).map(([svc, img]) => [svc, img.appVersion ?? img.tag])),
    notes: [...(release.qualification?.notes ?? []).filter((n: string) => !n.startsWith('Live qualification')), `Live qualification run ${path.basename(evidenceDir)}: ${status}; passed checks ${passed.join(', ')}. Evidence in docs/evidence/.`],
  };
  for (const f of RELEASE_FILES) release.files[f] = { sha256: sha256Hex(readFileSync(path.join(dir, f))) };
  writeFileSync(releasePath, JSON.stringify(release, null, 2) + '\n');
  console.log(`${id}: qualification ${status} (${versions['docker'] ?? '?'} / ${versions['compose'] ?? '?'} / ${versions['node'] ?? '?'})`);
}
