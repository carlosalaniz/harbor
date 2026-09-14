// pnpm openapi [--check]  — write docs/openapi.json from the live route schemas, or verify it is current.
import { readFileSync, writeFileSync } from 'node:fs';
import { generateOpenApi } from '../src/api/openapi.js';

const doc = await generateOpenApi();
const text = JSON.stringify(doc, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = readFileSync('docs/openapi.json', 'utf8');
  if (current !== text) {
    console.error('docs/openapi.json is stale; run pnpm openapi');
    process.exit(1);
  }
  console.log('docs/openapi.json is current');
} else {
  writeFileSync('docs/openapi.json', text);
  console.log(`wrote docs/openapi.json (${Object.keys(doc['paths'] as object).length} paths)`);
}
