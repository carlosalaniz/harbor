#!/usr/bin/env node
// Writes seccomp/browser-sandbox.json (decision 201): Docker's default seccomp profile at DOCKER_TAG, plus exactly one
// rule appended at the end of `syscalls` that lets a container create namespaces (clone, unshare, setns) and chroot.
// That is what Chromium's (and Firefox's) own sandbox needs inside a container; Docker's default allows those calls only
// with CAP_SYS_ADMIN, which Harbor never grants.
//
//   node scripts/seccomp-profile.mjs           # fetch Docker's default, write the profile, print the hash to record
//
// After a run, copy the printed UPSTREAM_SHA256 into src/planner/seccomp.ts; tests/unit/seccomp.test.ts checks that the
// shipped profile minus the added rule hashes to it, so the file can never drift from "Docker's default + one rule".
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DOCKER_TAG = 'docker-v29.9.3';
const SOURCE = `https://raw.githubusercontent.com/moby/moby/${DOCKER_TAG}/vendor/github.com/moby/profiles/seccomp/default.json`;

export const SANDBOX_RULE = {
  names: ['clone', 'unshare', 'setns', 'chroot'],
  action: 'SCMP_ACT_ALLOW',
  comment:
    `Harbor browser-sandbox permission (decision 201): a browser's own sandbox (user, PID and network namespaces, then chroot into an empty folder inside them). Everything else is Docker's default profile from moby ${DOCKER_TAG} (Apache-2.0).`,
};

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`);
const upstream = JSON.parse(await res.text());
const hash = createHash('sha256').update(JSON.stringify(upstream)).digest('hex');
const profile = { ...upstream, syscalls: [...upstream.syscalls, SANDBOX_RULE] };
const out = path.resolve(import.meta.dirname, '..', 'seccomp', 'browser-sandbox.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(profile, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), out)} from ${DOCKER_TAG}`);
console.log(`UPSTREAM_SHA256 = '${hash}'`);
