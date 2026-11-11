// Decision 200: announcing an endpoint on the LAN with DNS-SD (format, the pure planner, the avahi-publish children).
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { validateManifestReferences, validateManifestShape } from '../../src/packages/manifest.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { planAdverts, publishArgs, truncateBytes, type AdvertContext, type AdvertSource } from '../../src/advertise/adverts.js';
import { ProcessAdvertPublisher, RETRY_MS } from '../../src/advertise/publisher.js';
import { MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');
function load(advertise: string): void {
  const text = MINIMAL_MANIFEST.replace('    browserContext: secure\n', `    browserContext: secure\n    advertise:\n${advertise.replace(/^/gm, '      ')}\n`);
  validateManifestReferences(validateManifestShape(y(text)), validateComposeSource(y(MINIMAL_COMPOSE)));
}
const refused = (advertise: string, re: RegExp) => {
  try {
    load(advertise);
  } catch (e) {
    expect(`${(e as Error).message} ${((e as { details?: string[] }).details ?? []).join(' ')}`).toMatch(re);
    return;
  }
  throw new Error(`expected refusal of ${advertise}`);
};

describe('advertise: package format', () => {
  it('accepts a type alone, and a type with a name and TXT records', () => {
    load('type: _desk-panel._tcp');
    load('type: _http._tcp\nname: Desk panel renderer\ntxt:\n  path: /panel\n  proto: "1"\n  empty: ""');
    load('type: _a._tcp');
    load('type: _abcdefghijklmno._tcp'); // 15 characters
  });

  it('refuses a type that is not an RFC 6335 TCP service name', () => {
    for (const t of ['desk._tcp', '_desk._udp', '_Desk._tcp', '_123._tcp', '_-desk._tcp', '_desk-._tcp', '_de--sk._tcp', '_abcdefghijklmnop._tcp', '_desk.panel._tcp']) refused(`type: ${t}`, /type|pattern/);
  });

  it('refuses unknown keys, a long or multi-line name, and too many or bad TXT records', () => {
    refused('type: _desk._tcp\nport: 9', /additional/);
    refused(`type: _desk._tcp\nname: ${'é'.repeat(40)}`, /63 bytes/);
    refused('type: _desk._tcp\nname: "two\\nlines"', /pattern/);
    refused(`type: _desk._tcp\ntxt:\n${Array.from({ length: 9 }, (_, i) => `  k${i}: v`).join('\n')}`, /more than 8|maxProperties|must NOT have more/);
    refused('type: _desk._tcp\ntxt:\n  Path: /x', /property name|propertyNames|pattern/);
    refused('type: _desk._tcp\ntxt:\n  toolongkey: x', /property name|propertyNames|pattern/);
    refused('type: _desk._tcp\ntxt:\n  path: "$HOME"', /pattern/);
    refused(`type: _desk._tcp\ntxt:\n  path: ${'é'.repeat(150)}`, /200 bytes/);
  });

  it('refuses the TXT keys Harbor sets itself', () => {
    for (const k of ['app', 'harbor', 'scheme']) refused(`type: _desk._tcp\ntxt:\n  ${k}: x`, new RegExp(`Harbor sets ${k}`));
  });
});

const ctx = (over: Partial<AdvertContext> = {}): AdvertContext => ({ lan: true, https: false, securePort: (p) => p + 20000, ...over });
const app = (over: Partial<AdvertSource> = {}): AdvertSource => ({
  instanceId: 'panel',
  packageId: 'panel-browser',
  appName: 'Panel browser',
  running: true,
  access: 'lan',
  endpoints: [{ id: 'stream', hostPort: 18010, advertise: { type: '_desk-panel._tcp', txt: { proto: '1', path: '/panel' } } }],
  ...over,
});

describe('advertise: what is announced', () => {
  it('announces a running app on its plain LAN port with the package TXT records and Harbor\'s own', () => {
    const { adverts, off } = planAdverts(ctx(), [app()]);
    expect(off).toEqual([]);
    expect(adverts).toEqual([
      { key: 'panel/stream', instanceId: 'panel', endpointId: 'stream', name: 'Panel browser', type: '_desk-panel._tcp', port: 18010, txt: [['path', '/panel'], ['proto', '1'], ['app', 'panel-browser'], ['harbor', '1'], ['scheme', 'http']] },
    ]);
    expect(publishArgs(adverts[0]!)).toEqual(['-s', '-f', '--', 'Panel browser', '_desk-panel._tcp', '18010', 'path=/panel', 'proto=1', 'app=panel-browser', 'harbor=1', 'scheme=http']);
  });

  it('adds the secure twin when LAN HTTPS is on', () => {
    const { adverts } = planAdverts(ctx({ https: true }), [app()]);
    expect(adverts[0]!.port).toBe(18010);
    expect(adverts[0]!.txt.slice(-2)).toEqual([['scheme', 'http'], ['secure-port', '38010']]);
  });

  it('announces the secure twin as https under HTTPS only (the plain port is on loopback)', () => {
    const { adverts } = planAdverts(ctx({ https: true }), [app({ access: 'relay' })]);
    expect(adverts[0]!.port).toBe(38010);
    expect(adverts[0]!.txt.slice(-1)).toEqual([['scheme', 'https']]);
  });

  it('announces nothing without LAN mode, for a stopped app, or for an app bound to loopback', () => {
    expect(planAdverts(ctx({ lan: false }), [app()]).off.map((o) => o.reason)).toEqual(['lan-off']);
    expect(planAdverts(ctx(), [app({ running: false })]).off.map((o) => o.reason)).toEqual(['not-running']);
    expect(planAdverts(ctx(), [app({ access: 'loopback' })]).off.map((o) => o.reason)).toEqual(['loopback']);
    expect(planAdverts(ctx(), [app({ access: null })]).off.map((o) => o.reason)).toEqual(['loopback']);
    expect(planAdverts(ctx({ https: false }), [app({ access: 'relay' })]).adverts).toEqual([]);
  });

  it('uses the package name when given, and keeps names unique per type (avahi refuses a local duplicate)', () => {
    const named = { id: 'stream', hostPort: 18010, advertise: { type: '_desk-panel._tcp', name: 'Desk' } };
    const { adverts } = planAdverts(ctx(), [
      app({ instanceId: 'b', endpoints: [{ ...named, hostPort: 18020 }] }),
      app({ instanceId: 'a', endpoints: [named] }),
      app({ instanceId: 'c', endpoints: [{ ...named, hostPort: 18030, advertise: { ...named.advertise, name: 'DESK' } }] }),
      app({ instanceId: 'd', endpoints: [{ ...named, hostPort: 18040, advertise: { type: '_other._tcp', name: 'Desk' } }] }),
    ]);
    expect(adverts.map((a) => [a.instanceId, a.name])).toEqual([['a', 'Desk'], ['b', 'Desk #2'], ['c', 'DESK #3'], ['d', 'Desk']]);
  });

  it('keeps a name within 63 bytes, suffix included, without splitting a character', () => {
    expect(truncateBytes('é'.repeat(40), 63)).toBe('é'.repeat(31));
    const long = 'é'.repeat(40);
    const { adverts } = planAdverts(ctx(), [app({ instanceId: 'a', appName: long }), app({ instanceId: 'b', appName: long })]);
    for (const a of adverts) expect(Buffer.byteLength(a.name)).toBeLessThanOrEqual(63);
    expect(adverts[1]!.name.endsWith(' #2')).toBe(true);
  });
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];
  kill(sig: NodeJS.Signals): boolean {
    this.killed.push(sig);
    this.signalCode = sig;
    this.emit('exit', null, sig);
    return true;
  }
  die(code: number, stderr = ''): void {
    if (stderr) this.stderr.write(stderr);
    this.exitCode = code;
    setImmediate(() => this.emit('exit', code, null));
  }
}

function harness() {
  const spawned: { args: string[]; child: FakeChild }[] = [];
  const logs: string[] = [];
  let now = 1_000;
  const pub = new ProcessAdvertPublisher(
    { info: (m) => logs.push(m), warn: (m) => logs.push(`warn: ${m}`) },
    '/usr/bin/avahi-publish',
    (_bin, args) => {
      const child = new FakeChild();
      spawned.push({ args, child });
      return child as unknown as ChildProcess;
    },
    () => now,
  );
  return { pub, spawned, logs, advance: (ms: number) => (now += ms) };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('advertise: avahi-publish children', () => {
  const [a] = planAdverts(ctx(), [app()]).adverts;

  it('starts one child per announcement, leaves it alone while unchanged, and records the confirmed name', async () => {
    const h = harness();
    h.pub.apply([a!]);
    h.pub.apply([a!]);
    expect(h.spawned).toHaveLength(1);
    expect(h.pub.state(a!.key)?.state).toBe('starting');
    h.spawned[0]!.child.stdout.write("Established under name 'Panel browser'\n");
    await tick();
    expect(h.pub.state(a!.key)).toEqual({ state: 'announced', name: 'Panel browser', error: null });
  });

  it('restarts a child whose arguments changed and stops one no longer wanted', () => {
    const h = harness();
    h.pub.apply([a!]);
    h.pub.apply([{ ...a!, port: 38010 }]);
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[0]!.child.killed).toEqual(['SIGTERM']);
    h.pub.apply([]);
    expect(h.spawned[1]!.child.killed).toEqual(['SIGTERM']);
    expect(h.pub.state(a!.key)).toBeNull();
  });

  it('a child that exits on its own is failed with avahi\'s reason, logged once, and retried after the delay', async () => {
    const h = harness();
    h.pub.apply([a!]);
    h.spawned[0]!.child.die(1, 'Failed to add service: Local name collision\n');
    await tick();
    expect(h.pub.state(a!.key)).toEqual({ state: 'failed', name: null, error: 'Failed to add service: Local name collision' });
    h.pub.apply([a!]);
    expect(h.spawned).toHaveLength(1); // still waiting
    h.advance(RETRY_MS);
    h.pub.apply([a!]);
    expect(h.spawned).toHaveLength(2);
    h.spawned[1]!.child.die(1, 'Failed to add service: Local name collision\n');
    await tick();
    expect(h.logs.filter((l) => l.startsWith('warn:'))).toHaveLength(1);
  });

  it('close stops every child', async () => {
    const h = harness();
    h.pub.apply([a!, { ...a!, key: 'other/stream' }]);
    await h.pub.close();
    expect(h.spawned.every((s) => s.child.killed.length === 1)).toBe(true);
  });
});
