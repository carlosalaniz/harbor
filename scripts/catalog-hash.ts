// Editorial helper: recompute release.json file hashes for a package after editing its
// manifest/compose/README. Runtime never calls this; it only verifies.
//   pnpm tsx scripts/catalog-hash.ts <packageId> [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../src/packages/inventory.js';
import { RELEASE_FILES } from '../src/contracts/release.schema.js';

const [id, flag] = process.argv.slice(2);
if (!id) { console.error('usage: catalog-hash.ts <packageId> [--check]'); process.exit(2); }
const dir = path.resolve('catalog', id);
const releasePath = path.join(dir, 'release.json');
const release = JSON.parse(readFileSync(releasePath, 'utf8'));
let changed = false;
for (const f of RELEASE_FILES) {
  const h = sha256Hex(readFileSync(path.join(dir, f)));
  if (release.files[f]?.sha256 !== h) { changed = true; release.files[f] = { sha256: h }; }
}
if (flag === '--check') {
  if (changed) { console.error(`${id}: release.json hashes are stale`); process.exit(1); }
  console.log(`${id}: hashes ok`);
} else {
  writeFileSync(releasePath, JSON.stringify(release, null, 2) + '\n');
  console.log(`${id}: ${changed ? 'updated' : 'unchanged'}`);
}
