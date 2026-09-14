#!/usr/bin/env node
// Render docs/VERIFICATION.md sections 3-4 from a live run directory's report.json.
//   node scripts/vm/verification-report.mjs docs/evidence/<run-id>  [--write]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const [dir, flag] = process.argv.slice(2);
if (!dir) { console.error('usage: verification-report.mjs <run-dir> [--write]'); process.exit(2); }
const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
const md = readFileSync(path.join(dir, 'report.md'), 'utf8');
const a01 = report.results.find((r) => r.id === 'A01');
const v = a01?.details?.versions ?? {};
const files = readdirSync(dir).filter((f) => !f.startsWith('report.')).sort();
const runId = path.basename(dir);
const counts = report.results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});

const section3 = `Run **${runId}** (${report.startedAt} → ${report.updatedAt}). Full table with notes: \`docs/evidence/${runId}/report.md\`; details: \`report.json\`.
Result counts: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}.

${md.split('\n').filter((l) => l.startsWith('| A') || l.startsWith('| ID') || l.startsWith('|---')).join('\n')}

Evidence files: ${files.map((f) => `\`${f}\``).join(', ')}.`;

const section4 = `| Component | Version | Source |
|---|---|---|
| Host OS | ${v.ubuntu ?? '?'} (${v.arch ?? '?'}), ${v.systemd ?? '?'} | fresh DigitalOcean image \`ubuntu-24-04-x64\` |
| Docker Engine | ${v.docker ?? '?'} | installed by bootstrap \`--install-docker\` from download.docker.com (noble stable) |
| Docker Compose plugin | ${v.compose ?? '?'} | same repository |
| Node.js (bundled) | ${v.node ?? '?'} | nodejs.org linux-x64 tarball, SHA256 verified at packaging |
| Harbor | ${v.harbor ?? '?'} | release archive \`harbor-${v.harbor ?? '?'}-linux-x64.tar.gz\` |
| Excalidraw | \`excalidraw/excalidraw@sha256:f7ee194a…\` (tag latest, 2026-05-06) | catalog/excalidraw/release.json |
| BentoPDF | \`ghcr.io/alam00000/bentopdf-simple@sha256:3d62b8f8…\` (v2.8.8) | catalog/bentopdf/release.json |
| n8n | \`n8nio/n8n@sha256:a8c95f75…\` (2.38.7) | catalog/n8n/release.json |
| PostgreSQL | \`postgres@sha256:f1c3376c…\` (16.15) | catalog/n8n/release.json |
| Portainer CE | \`portainer/portainer-ce@sha256:0e3c8bc8…\` (2.39.7) | src/bootstrap/tools.ts |
| Cockpit | Ubuntu 24.04 \`cockpit\` package (universe) at run time | apt |`;

if (flag === '--write') {
  const target = path.resolve('docs/VERIFICATION.md');
  let doc = readFileSync(target, 'utf8');
  doc = doc.replace('RUN_PLACEHOLDER', section3).replace('VERSIONS_PLACEHOLDER', section4);
  writeFileSync(target, doc);
  console.log(`updated ${target}`);
} else {
  console.log(section3 + '\n\n' + section4);
}
