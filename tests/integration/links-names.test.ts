import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import type { InstanceSummary, PackageImportResultDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { projectNameFor } from '../../src/naming.js';
import { isHarborSubnet } from '../../src/planner/subnets.js';
import { startHarness, type Harness } from './harness.js';

// Decision 171: names on a link network. Compose gives every service it attaches its own service name as a
// name on each network, and a container on several networks resolves a name on any of them (checked on
// Docker 29: the app's own network answers first, but while the provider's `db` is stopped its `server`
// resolved `db` to the consumer's container on the link network). So the runner attaches both sides itself,
// with only the names Harbor chooses: the consumer's bound services none, the provider's endpoint service
// `<id>-link`. Here the consumer's bound service is deliberately called `db` and its other one `web`, both
// names the provider also uses.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const head = (id: string, services: string, port = 80, revision = '1') => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: ${id}
  description: ${id} for the link names tests
release:
  revision: "${revision}"
deployment:
  compose: compose.yaml
  multiInstance: false
  services:
${services}
endpoints:
  web:
    service: web
    containerPort: ${port}
    scheme: http
    exposure: direct
    browserContext: ordinary
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
const providerAt = (revision: string) => head('namedocs', '    web: application\n    db: infrastructure', 3010, revision);
const provider = providerAt('1');
const consumerAt = (revision: string) =>
  head('shadowish', '    web: application\n    db: application', 80, revision) +
  `links:
  - id: docs
    purpose: The documents app it reads
    provider: {packages: [namedocs]}
    bindings:
      - {service: db, environment: DOCS_BASE_URL}
`;
const consumer = consumerAt('1');
const composeOf = (services: string[]) => `services:\n${services.map((s) => `  ${s}:\n    image: nginx:1.27-alpine\n`).join('')}`;
const upload = (m: string, services: string[]) => h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: 'p.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': m, 'compose.yaml': composeOf(services) }).toString('base64')}` });
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name)!;
const runtimeFile = (id: string) => path.join(h.stateDir, 'instances', id, 'runtime', 'compose.yaml');
const runtime = (id: string) => readFileSync(runtimeFile(id), 'utf8');
const containerNamed = (name: string) => [...h.fake.containers.values()].find((c) => c.name === name)!;
const networkNamed = (name: string) => [...h.fake.networks.values()].find((n) => n.name === name)!;

describe('link networks carry only the names Harbor gives (decision 171)', () => {
  let docs: InstanceSummary;
  let shadow: InstanceSummary;
  let net: string;
  let consumerDb: string; // the consumer's bound service, named `db`
  let providerWeb: string; // the provider's endpoint service
  const clean = () => {
    expect(new Set(networkNamed(net).containerIds)).toEqual(new Set([containerNamed(consumerDb).id, containerNamed(providerWeb).id]));
    expect(h.fake.aliasesOn(consumerDb, net)).toEqual([]);
    expect(h.fake.aliasesOn(providerWeb, net)).toEqual(['docs-link']);
    const names = h.fake.namesOn(net);
    expect(names).toContain('docs-link');
    expect(names).not.toContain('db');
    expect(names).not.toContain('web');
  };
  // A 0.31.0 Compose file: the link network declared external and joined by the service (with the alias on
  // the provider), which is how Compose came to give it its service name there.
  const legacyFile = (id: string, service: string, aliases: string[]) => {
    const doc = parseYaml(runtime(id));
    doc.services[service].networks = { default: {}, [net]: aliases.length ? { aliases } : {} };
    doc.networks[net] = { name: net, external: true };
    writeFileSync(runtimeFile(id), yamlStringify(doc));
    expect(runtime(id)).toContain(net);
  };
  // How 0.31.0 and older left them: Compose attached both sides and added each service name (and Docker's
  // short id, which older engines list among the aliases).
  const legacy = async () => {
    const n = networkNamed(net);
    for (const [name, svc, extra] of [
      [consumerDb, 'db', []],
      [providerWeb, 'web', ['docs-link']],
    ] as const) {
      const id = containerNamed(name).id;
      await h.fake.disconnectNetwork(n.id, id);
      await h.fake.connectNetwork(n.id, id, [id.slice(0, 12), name, svc, ...extra]);
    }
    legacyFile(shadow.id, 'db', []);
    legacyFile(docs.id, 'web', ['docs-link']);
    expect(h.fake.namesOn(net)).toEqual(expect.arrayContaining(['db', 'web']));
  };

  it('install: the consumer service called db answers to no name on the link network, the provider only to docs-link', async () => {
    await upload(provider, ['web', 'db']);
    await upload(consumer, ['web', 'db']);
    expect((await h.api.run({ kind: 'install', packageId: 'namedocs' })).op.state).toBe('succeeded');
    const { plan, op } = await h.api.run({ kind: 'install', packageId: 'shadowish' });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    docs = await byName('namedocs');
    shadow = await byName('shadowish');
    net = plan.links[0]!.network;
    consumerDb = `${projectNameFor(shadow.id)}-db-1`;
    providerWeb = `${projectNameFor(docs.id)}-web-1`;
    clean();
    // the provider's db and the consumer's web never join
    expect(networkNamed(net).containerIds).not.toContain(containerNamed(`${projectNameFor(docs.id)}-db-1`).id);
    expect(networkNamed(net).containerIds).not.toContain(containerNamed(`${projectNameFor(shadow.id)}-web-1`).id);
    // the address the consumer gets is unchanged
    expect(h.fake.envOf(consumerDb)?.['DOCS_BASE_URL']).toBe('http://docs-link:3010');
    // decision 191: the link network's subnet comes from Harbor's block too
    expect(isHarborSubnet(networkNamed(net).subnets[0]!)).toBe(true);
    // neither Compose file mentions the link network, so Compose never names anything on it
    expect(runtime(shadow.id)).not.toContain(net);
    expect(runtime(docs.id)).not.toContain(net);
    expect(runtime(docs.id)).not.toContain('docs-link');
  });

  it('the consumer is on the link network before it starts (create, attach, then start)', async () => {
    const project = projectNameFor(shadow.id);
    const from = h.fake.log.length;
    expect((await h.api.run({ kind: 'restart', instanceId: shadow.id })).op.state).toBe('succeeded');
    const log = h.fake.log.slice(from);
    const create = log.indexOf(`up ${project} --no-start --force-recreate`);
    const attach = log.indexOf(`network connect ${net} ${consumerDb}`);
    const start = log.indexOf(`up ${project}`);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(attach).toBeGreaterThan(create);
    expect(start).toBeGreaterThan(attach);
    clean();
  });

  it('Restart, Stop and Start of either side keep it that way', async () => {
    expect((await h.api.run({ kind: 'restart', instanceId: docs.id })).op.state).toBe('succeeded');
    clean();
    expect((await h.api.run({ kind: 'stop', instanceId: docs.id })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'start', instanceId: docs.id })).op.state).toBe('succeeded');
    clean();
    expect((await h.api.run({ kind: 'stop', instanceId: shadow.id })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'start', instanceId: shadow.id })).op.state).toBe('succeeded');
    clean();
  });

  it('an existing link converges on the next Start of the consumer: same containers, same address', async () => {
    await legacy();
    const ids = [containerNamed(consumerDb).id, containerNamed(providerWeb).id];
    expect((await h.api.run({ kind: 'stop', instanceId: shadow.id })).op.state).toBe('succeeded');
    const { op } = await h.api.run({ kind: 'start', instanceId: shadow.id });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    clean();
    expect([containerNamed(consumerDb).id, containerNamed(providerWeb).id]).toEqual(ids);
    expect(h.fake.envOf(consumerDb)?.['DOCS_BASE_URL']).toBe('http://docs-link:3010');
    const events = op.events.map((e) => e.message).join('\n');
    expect(events).toMatch(/re-attached .*-web-1 to link network .* as docs-link only \(it also answered there to web\)/);
    expect(events).toMatch(/re-attached .*-db-1 to link network .* under no name of its own \(it also answered there to db\)/);
    // Start runs `compose start` on the file it has: Compose never attaches networks on start (checked on
    // Docker 29.2.1 / Compose v5.1.0), so the old declaration is harmless until the next `up` rewrites it.
    expect(runtime(shadow.id)).toContain(net);
  });

  it('an existing link converges on the next Restart of the provider too, and the Compose file loses the link network', async () => {
    await legacy();
    expect((await h.api.run({ kind: 'restart', instanceId: docs.id })).op.state).toBe('succeeded');
    clean();
    expect(runtime(docs.id)).not.toContain(net);
  });

  it('an existing link converges on a configure of the consumer (relink to the same provider)', async () => {
    await legacy();
    const { op } = await h.api.run({ kind: 'configure', instanceId: shadow.id, links: { docs: { instanceId: docs.id } } });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    clean();
    expect(runtime(shadow.id)).not.toContain(net);
  });

  it('an update of either side (new revision) creates, attaches, then starts, and keeps the names clean', async () => {
    await legacy();
    const project = projectNameFor(shadow.id);
    await upload(consumerAt('2'), ['web', 'db']);
    const from = h.fake.log.length;
    const { op } = await h.api.run({ kind: 'update', instanceId: shadow.id });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const log = h.fake.log.slice(from);
    const create = log.indexOf(`up ${project} --no-start`);
    const attach = log.findIndex((l, i) => i > create && l.startsWith(`network connect ${net} ${consumerDb}`));
    const start = log.indexOf(`up ${project}`, create + 1);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(attach).toBeGreaterThan(create);
    expect(start).toBeGreaterThan(attach);
    clean();
    expect(runtime(shadow.id)).not.toContain(net);
    expect(h.fake.envOf(consumerDb)?.['DOCS_BASE_URL']).toBe('http://docs-link:3010');
    await upload(providerAt('2'), ['web', 'db']);
    expect((await h.api.run({ kind: 'update', instanceId: docs.id })).op.state).toBe('succeeded');
    clean();
    expect(runtime(docs.id)).not.toContain(net);
  });

  it('a link nobody touches is switched once when the daemon starts (relink, actor link-guard): nothing recreated, both files rewritten', async () => {
    await legacy();
    const repo = () => h.daemon.ctx.repo;
    const before = new Set(repo().listOperations(500).map((o) => o.id));
    const ids = [...h.fake.containers.values()].filter((c) => c.project === projectNameFor(shadow.id) || c.project === projectNameFor(docs.id)).map((c) => `${c.name}=${c.id}`).sort();
    const from = h.fake.log.length;
    await h.restart(); // what a Harbor upgrade does
    let relink = repo().listOperations(500).find((o) => !before.has(o.id) && o.kind === 'relink');
    for (let i = 0; i < 200 && (!relink || !['succeeded', 'failed', 'needs_action'].includes(relink.state)); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      relink = repo().listOperations(500).find((o) => !before.has(o.id) && o.kind === 'relink');
    }
    expect(relink?.state, JSON.stringify(relink)).toBe('succeeded');
    expect(relink!.actor).toBe('link-guard');
    expect(relink!.instanceId).toBe(shadow.id);
    clean();
    // same containers, nothing created, stopped or started: only the link network attachments changed
    expect([...h.fake.containers.values()].filter((c) => c.project === projectNameFor(shadow.id) || c.project === projectNameFor(docs.id)).map((c) => `${c.name}=${c.id}`).sort()).toEqual(ids);
    expect(h.fake.log.slice(from).filter((l) => /^(up|start|stop|down|rm) /.test(l))).toEqual([]);
    expect(runtime(shadow.id)).not.toContain(net);
    expect(runtime(docs.id)).not.toContain(net);
    expect(h.fake.envOf(consumerDb)?.['DOCS_BASE_URL']).toBe('http://docs-link:3010');
    // a clean link is read once per start and left alone
    const now = new Set(repo().listOperations(500).map((o) => o.id));
    await h.restart();
    await new Promise((r) => setTimeout(r, 1500));
    expect(repo().listOperations(500).filter((o) => !now.has(o.id) && o.kind === 'relink')).toEqual([]);
  });

  it('relink is internal: the API does not take it', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'relink', instanceId: shadow.id });
  });
});
