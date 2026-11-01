import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { isHarborSubnet } from '../../src/planner/subnets.js';
import { LABELS } from '../../src/naming.js';
import { startHarness, type Harness } from './harness.js';

// Decision 191: Harbor picks every new network's subnet from 10.200.0.0/13 instead of Docker's default pools, which
// a box with other Compose stacks' leftovers had filled ("all predefined address pools have been fully subnetted":
// every new install failed). Networks that already exist keep their subnet.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const runtimeFile = (id: string) => path.join(h.stateDir, 'instances', id, 'runtime', 'compose.yaml');
const fileSubnet = (id: string) => parseYaml(readFileSync(runtimeFile(id), 'utf8')).networks.default.ipam?.config?.[0]?.subnet as string | undefined;
const appNetwork = async (id: string) => [...h.fake.networks.values()].find((n) => n.labels[LABELS.instance] === id && n.labels[LABELS.kind] === 'network')!;

describe('Harbor chooses app network subnets (decision 191)', () => {
  let first: string;

  it('a new install gets a /24 from Harbor block, named in its Compose file', async () => {
    const { op } = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    first = op.instanceId;
    const net = await appNetwork(first);
    expect(net.subnets).toHaveLength(1);
    expect(isHarborSubnet(net.subnets[0]!)).toBe(true);
    expect(fileSubnet(first)).toBe(net.subnets[0]);
  });

  it('a restart keeps the same subnet', async () => {
    const before = (await appNetwork(first)).subnets[0];
    const { op } = await h.api.run({ kind: 'restart', instanceId: first });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect((await appNetwork(first)).subnets[0]).toBe(before);
    expect(fileSubnet(first)).toBe(before);
  });

  it('skips subnets other networks or this machine use', async () => {
    const taken = (await appNetwork(first)).subnets[0]!; // 10.200.0.0/24
    h.net.ranges = ['192.168.1.0/24', '10.200.1.0/24']; // e.g. a VPN on the next one
    const { op } = await h.api.run({ kind: 'install', packageId: 'freshrss' });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const got = (await appNetwork(op.instanceId)).subnets[0]!;
    expect(isHarborSubnet(got)).toBe(true);
    expect([taken, '10.200.1.0/24']).not.toContain(got);
    h.net.ranges = ['192.168.1.0/24'];
  });

  it('a network from before 0.39.0 keeps the subnet Docker gave it and the file names none', async () => {
    // How an older Harbor left it: Docker picked the subnet and the file has no ipam.
    const net = await appNetwork(first);
    net.subnets = ['172.30.77.0/24'];
    const doc = parseYaml(readFileSync(runtimeFile(first), 'utf8'));
    delete doc.networks.default.ipam;
    writeFileSync(runtimeFile(first), yamlStringify(doc));
    const { op } = await h.api.run({ kind: 'restart', instanceId: first });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect((await appNetwork(first)).subnets).toEqual(['172.30.77.0/24']);
    expect(fileSubnet(first)).toBeUndefined();
  });

  it('when nothing in the block is free, the install fails with what to do', async () => {
    h.net.ranges = ['10.0.0.0/8'];
    const { op } = await h.api.run({ kind: 'install', packageId: 'memos' });
    expect(op.state).toBe('failed');
    expect(op.error?.message).toMatch(/no free address range for network .*10\.200\.0\.0\/13/);
    expect(op.error?.nextAction).toMatch(/docker network rm/);
    h.net.ranges = ['192.168.1.0/24'];
  });
});
