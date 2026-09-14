// Load and fully validate every bundled package exactly as the daemon does.
import path from 'node:path';
import { listCatalog, loadPackage, readCatalogIndex } from '../src/packages/catalog.js';

const catalogDir = path.resolve(process.argv[2] ?? 'catalog');
const index = readCatalogIndex(catalogDir);
let failed = 0;
for (const id of Object.keys(index.packages)) {
  try {
    const pkg = loadPackage(catalogDir, id);
    console.log(`ok   ${id}@${pkg.revision} qualification=${pkg.release.qualification.status} images=${Object.values(pkg.release.images).map((i) => i.reference).join(',')}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${id}: ${(e as Error).message}`);
  }
}
console.log(JSON.stringify(listCatalog(catalogDir), null, 2));
process.exit(failed ? 1 : 0);
