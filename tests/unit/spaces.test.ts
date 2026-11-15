import { describe, expect, it } from 'vitest';
import { checkSpaceName, memberAliases, normaliseSpaces, spaceAddress, spaceConflicts, spaceNames, spaceNetworkLabels, spaceNetworkName, type SpaceMember } from '../../src/planner/spaces.js';

const erp: SpaceMember = { instanceId: 'i1', name: 'erpnext', services: ['frontend', 'backend', 'db'], mainService: 'frontend' };
const webui: SpaceMember = { instanceId: 'i2', name: 'open-webui', services: ['web'], mainService: 'web' };

describe('spaces (decision 202)', () => {
  it('names the network and labels it as a space of this installation', () => {
    expect(spaceNetworkName('0a1b2c3d')).toBe('hb_space_0a1b2c3d');
    expect(spaceNetworkLabels('inst', '0a1b2c3d')).toEqual({ 'io.harbor.preview/installation': 'inst', 'io.harbor.preview/kind': 'space', 'io.harbor.preview/space': '0a1b2c3d' });
  });

  it('gives the main service the app name and every service <app>-<service>', () => {
    expect(memberAliases(erp)).toEqual({ frontend: ['erpnext', 'erpnext-frontend'], backend: ['erpnext-backend'], db: ['erpnext-db'] });
    expect(memberAliases({ ...erp, mainService: null })).toEqual({ frontend: ['erpnext-frontend'], backend: ['erpnext-backend'], db: ['erpnext-db'] });
  });

  it('accepts distinct apps', () => {
    expect(spaceConflicts([erp, webui])).toEqual([]);
  });

  it('refuses two apps answering to one name', () => {
    const a: SpaceMember = { instanceId: 'a', name: 'erp', services: ['next'], mainService: 'next' };
    const b: SpaceMember = { instanceId: 'b', name: 'erp-next', services: ['web'], mainService: 'web' };
    expect(spaceConflicts([a, b])).toEqual(['erp and erp-next would both answer to erp-next']);
  });

  it('refuses a name that is a service name of a member (it would shadow that app\'s own lookups)', () => {
    const db: SpaceMember = { instanceId: 'd', name: 'db', services: ['postgres'], mainService: 'postgres' };
    expect(spaceConflicts([erp, db])).toEqual(['the name db (db) is also a service name inside erpnext']);
  });

  it('refuses names longer than a DNS label', () => {
    const long: SpaceMember = { instanceId: 'l', name: 'a'.repeat(60), services: ['backend'], mainService: null };
    expect(spaceConflicts([long])[0]).toMatch(/longer than 63 characters/);
  });

  it('shows a URL when the port is known, else the bare name', () => {
    expect(spaceAddress('erpnext', 8080)).toBe('http://erpnext:8080');
    expect(spaceAddress('erpnext-db', null)).toBe('erpnext-db');
  });

  it('checks names', () => {
    expect(checkSpaceName('AI tooling')).toBeNull();
    expect(checkSpaceName('  ')).toMatch(/needs a name/);
    expect(checkSpaceName('x'.repeat(41))).toMatch(/at most 40/);
    expect(checkSpaceName('a\nb')).toMatch(/control/);
  });

  it('drops gone apps and keeps an app in its first space only', () => {
    const out = normaliseSpaces(
      [
        { id: 'a', name: 'A', shared: false, apps: ['x', 'gone', 'y'] },
        { id: 'b', name: 'B', shared: true, apps: ['y', 'z'] },
      ],
      (id) => id !== 'gone',
    );
    expect(out.map((s) => s.apps)).toEqual([['x', 'y'], ['z']]);
  });
});

describe('spaces: self-names (decision 202)', () => {
  it('lets an app whose name equals its main service keep it', () => {
    expect(spaceConflicts([{ instanceId: 'w', name: 'web', services: ['web', 'db'], mainService: 'web' }])).toEqual([]);
  });
});

describe('spaces: names really given (decision 202)', () => {
  it('leaves out only the names a conflict touches', () => {
    const a: SpaceMember = { instanceId: 'a', name: 'erp', services: ['next', 'db'], mainService: 'next' };
    const b: SpaceMember = { instanceId: 'b', name: 'erp-next', services: ['web'], mainService: 'web' };
    const r = spaceNames([a, b]);
    expect(r.names).toEqual({ a: { next: ['erp'], db: ['erp-db'] }, b: { web: ['erp-next-web'] } });
    expect(r.conflicts).toHaveLength(1);
  });
});
