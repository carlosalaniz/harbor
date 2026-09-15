#!/usr/bin/env node
// Render the "Live catalog qualification" section of docs/VERIFICATION.md from one or more
// docs/evidence/catalog-* run directories, plus the qualified-versions table from every release.json.
//   node scripts/vm/catalog-verification-section.mjs docs/evidence/catalog-A [docs/evidence/catalog-B ...] [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const write = args.includes('--write');
const dirs = args.filter((a) => !a.startsWith('--'));
if (!dirs.length) { console.error('usage: catalog-verification-section.mjs <run-dir>... [--write]'); process.exit(2); }

const rows = [];
let versions = null;
for (const dir of dirs) {
  const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
  versions ??= report.versions;
  for (const r of report.results_detail.filter((x) => x.id !== 'HOST')) rows.push({ run: report.runId, ...r });
}
// latest result per step wins (a re-run supersedes an earlier failure)
const latest = new Map();
for (const r of rows) latest.set(r.id, r);
const table = ['| Step | Result | Run | Notes |', '|---|---|---|---|', ...[...latest.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => `| ${r.id} | **${r.status.toUpperCase()}** | ${r.run} | ${r.notes.map((n) => String(n).split('\n')[0].slice(0, 300)).join('<br>').replace(/\|/g, '/')} |`)];
const passed = [...latest.values()].filter((r) => r.status === 'pass').length;

const index = JSON.parse(readFileSync('catalog/index.json', 'utf8'));
const qual = ['| Package | Images (tag → index digest) | Qualification |', '|---|---|---|'];
for (const id of Object.keys(index.packages).sort()) {
  const rel = JSON.parse(readFileSync(path.join('catalog', id, 'release.json'), 'utf8'));
  const imgs = Object.entries(rel.images).map(([svc, i]) => `${svc}: \`${i.repository}:${i.tag}\` → \`${i.reference.split('@')[1].slice(0, 19)}…\``).join('<br>');
  qual.push(`| ${id} | ${imgs} | ${rel.qualification.status} (${rel.qualification.date}) |`);
}

const section = `### Live catalog qualification (\`node scripts/vm/qualify-catalog.mjs --fresh\`)

Every bundled package is installed with the CLI on the designated droplet (fresh Ubuntu 24.04.4 x86-64; Docker ${versions?.docker}, Compose ${versions?.compose}, Node ${versions?.node}), waited for until Harbor reports it healthy, opened in headless Chromium (title, screenshot, health probe through the SSH tunnel), inspected (containers, mounts, resources) and removed. Packages with external storage claims are installed a second time with host folders under \`/srv/harbor-test-storage\` and the bind mounts are verified. ${passed} of ${latest.size} steps passed; reports and screenshots: ${dirs.map((d) => `\`${d}/\``).join(', ')}.

${table.join('\n')}
`;
const qualSection = `### Catalog images and qualification (from \`catalog/*/release.json\`)

${qual.join('\n')}
`;
if (!write) { console.log(section + '\n' + qualSection); process.exit(0); }
const target = 'docs/VERIFICATION.md';
let doc = readFileSync(target, 'utf8');
const cut = (text, startMarker, endMarker) => {
  const s = text.indexOf(startMarker);
  if (s < 0) return text;
  const e = text.indexOf(endMarker, s + startMarker.length);
  return text.slice(0, s) + (e < 0 ? '' : text.slice(e));
};
doc = cut(doc, '### Live catalog qualification', '\n## 4. Qualified versions');
doc = doc.replace('\n## 4. Qualified versions', `\n${section}\n## 4. Qualified versions`);
doc = cut(doc, '### Catalog images and qualification', '\n## 5. Limitations');
doc = doc.replace('\n## 5. Limitations', `\n${qualSection}\n## 5. Limitations`);
writeFileSync(target, doc);
console.log(`wrote ${target}: ${passed}/${latest.size} catalog steps passed`);
