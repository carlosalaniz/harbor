import { describe, expect, it } from 'vitest';
import { HARBOR_SUBNET_BLOCK, isHarborSubnet, pickSubnet, routesFromProcNetRoute, subnetsOverlap } from '../../src/planner/subnets.js';
import { renderCompose } from '../../src/planner/render.js';
import { identityFor } from '../../src/planner/identity.js';
import { validateManifestShape } from '../../src/packages/manifest.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');

// A real /proc/net/route from a box on 192.168.0.0/24 with Docker bridges and Tailscale (decision 191).
const PROC_NET_ROUTE = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
enp2s0	00000000	0100A8C0	0003	0	0	100	00000000	0	0	0
docker0	000011AC	00000000	0001	0	0	0	0000FFFF	0	0	0
enp2s0	0000A8C0	00000000	0001	0	0	100	00FFFFFF	0	0	0
enp2s0	0100A8C0	00000000	0005	0	0	100	FFFFFFFF	0	0	0
tun0	0000C80A	00000000	0001	0	0	0	0000FFFF	0	0	0
`;

describe('Harbor subnets (decision 191)', () => {
  it('hands out the first /24 of its block when nothing is taken', () => {
    expect(HARBOR_SUBNET_BLOCK).toBe('10.200.0.0/13');
    expect(pickSubnet([])).toBe('10.200.0.0/24');
  });

  it('skips Docker networks, routes and interfaces that overlap, whatever their size', () => {
    expect(pickSubnet(['10.200.0.0/24', '10.200.1.0/24'])).toBe('10.200.2.0/24');
    expect(pickSubnet(['10.200.0.0/16'])).toBe('10.201.0.0/24'); // a VPN routing all of 10.200
    expect(pickSubnet(['10.0.0.0/8', '10.208.0.0/24'])).toBeNull(); // the whole block is someone else's
    expect(pickSubnet(['10.200.0.5'])).toBe('10.200.1.0/24'); // a bare interface address counts as a /32
  });

  it('ignores a default route, IPv6 and garbage', () => {
    expect(pickSubnet(['0.0.0.0/0', 'fd00::/8', 'nonsense', '10.200.0.0/99'])).toBe('10.200.0.0/24');
  });

  it('runs out after 2048 networks', () => {
    const all = Array.from({ length: 2048 }, (_, i) => `10.${200 + (i >> 8)}.${i & 255}.0/24`);
    expect(pickSubnet(all.slice(0, 2047))).toBe('10.207.255.0/24');
    expect(pickSubnet(all)).toBeNull();
  });

  it('knows its own subnets', () => {
    expect(isHarborSubnet('10.203.17.0/24')).toBe(true);
    expect(isHarborSubnet('10.208.0.0/24')).toBe(false); // outside the block
    expect(isHarborSubnet('10.200.0.0/16')).toBe(false); // not a /24 Harbor made
    expect(isHarborSubnet('172.23.0.0/16')).toBe(false); // Docker's own pools: a network from before 0.39.0
  });

  it('overlap is symmetric and size-aware', () => {
    expect(subnetsOverlap('10.200.3.0/24', '10.0.0.0/8')).toBe(true);
    expect(subnetsOverlap('10.0.0.0/8', '10.200.3.0/24')).toBe(true);
    expect(subnetsOverlap('10.200.3.0/24', '10.200.4.0/24')).toBe(false);
  });

  it('reads /proc/net/route, leaving out the default route', () => {
    expect(routesFromProcNetRoute(PROC_NET_ROUTE)).toEqual(['172.17.0.0/16', '192.168.0.0/24', '192.168.0.1/32', '10.200.0.0/16']);
    expect(pickSubnet(routesFromProcNetRoute(PROC_NET_ROUTE))).toBe('10.201.0.0/24');
    expect(routesFromProcNetRoute('')).toEqual([]);
  });

  it('the Compose file names the subnet only when Harbor chose one', () => {
    const identity = identityFor('0a0a0a0a-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111');
    const base = { manifest: validateManifestShape(y(MINIMAL_MANIFEST)), compose: validateComposeSource(y(MINIMAL_COMPOSE)), identity, endpoints: [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }], secretValues: null };
    const legacy = renderCompose(base).model['networks'] as Record<string, Record<string, unknown>>;
    expect(legacy['default']!['ipam']).toBeUndefined();
    const fresh = renderCompose({ ...base, subnet: '10.200.7.0/24' }).model['networks'] as Record<string, Record<string, unknown>>;
    expect(fresh['default']!['ipam']).toEqual({ config: [{ subnet: '10.200.7.0/24' }] });
  });
});
