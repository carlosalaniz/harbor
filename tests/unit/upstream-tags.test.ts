import { describe, expect, it } from 'vitest';
import { bumpLevel, checkPolicy, commonCandidates, isDataStore, lockstepGroups, maxLevel, newerTags, replaceVersions, tagShape } from '../../scripts/upstream-tags.js';

// Decision 175: the catalog bot moves an app only to a newer tag of the same shape, and says how big the move is.
describe('upstream tags', () => {
  it('compares tags of the same shape only', () => {
    expect(tagShape('v0.11.3')).toEqual({ key: 'v#.#.#', nums: [0, 11, 3] });
    expect(tagShape('latest')).toBeNull();
    const tags = ['v0.11.3', 'v0.11.4', 'v0.12.0', 'v0.12.0-cuda', 'v0.12.0-rc1', 'latest', 'main', 'v0.9.9', 'v1.0'];
    expect(newerTags('v0.11.3', tags)).toEqual([
      { tag: 'v0.12.0', level: 'major' },
      { tag: 'v0.11.4', level: 'minor' },
    ]);
    expect(newerTags('latest', tags)).toEqual([]);
    expect(newerTags('8.1.3-bookworm', ['8.1.4-bookworm', '8.2.0-bookworm', '9.0.0-bookworm', '8.2.0-alpine', '8.2.0'])).toEqual([
      { tag: '9.0.0-bookworm', level: 'major' },
      { tag: '8.2.0-bookworm', level: 'minor' },
      { tag: '8.1.4-bookworm', level: 'patch' },
    ]);
  });
  it('a switch from versions to dates is never taken; databases are known by their image', () => {
    expect(newerTags('2.8.3', ['2021.11.28', '2.8.4']).map((c) => c.tag)).toEqual(['2.8.4']);
    expect(newerTags('2024.10.1', ['2025.1.0']).map((c) => c.tag)).toEqual(['2025.1.0']); // date to date is fine
    for (const r of ['postgres', 'library/postgres', 'docker.io/library/mariadb', 'pgautoupgrade/pgautoupgrade', 'valkey/valkey', 'ghcr.io/immich-app/postgres', 'mongo']) expect(isDataStore(r), r).toBe(true);
    for (const r of ['ghcr.io/open-webui/open-webui', 'n8nio/n8n', 'gotenberg/gotenberg', 'redisinsight/redisinsight']) expect(isDataStore(r), r).toBe(false);
  });
  it('numbers compare as numbers, not text', () => {
    expect(newerTags('1.9.0', ['1.10.0', '1.8.9']).map((c) => c.tag)).toEqual(['1.10.0']);
  });
  it('0.x moves count one place further; withinMajor keeps infrastructure on its major', () => {
    expect(bumpLevel([3, 2, 1], [3, 3, 1])).toBe('minor');
    expect(bumpLevel([3, 2, 1], [3, 2, 2])).toBe('patch');
    expect(bumpLevel([3, 2, 1], [4, 0, 0])).toBe('major');
    expect(bumpLevel([0, 11, 3], [0, 12, 0])).toBe('major');
    expect(bumpLevel([0, 11, 3], [0, 11, 4])).toBe('minor');
    expect(bumpLevel([0, 0, 3], [0, 0, 4])).toBe('major');
    expect(bumpLevel([1, 2], [1, 2])).toBeNull();
    expect(newerTags('16.15', ['16.16', '17.6', '18.0'], { withinMajor: true })).toEqual([{ tag: '16.16', level: 'minor' }]);
    expect(newerTags('16', ['17', '18'], { withinMajor: true })).toEqual([]);
    expect(maxLevel(['patch', 'major', 'minor'])).toBe('major');
    expect(maxLevel([])).toBeNull();
  });
  it('a package rule can narrow the tags', () => {
    expect(newerTags('2.4', ['2.5', '3.0'], { match: /^2\./ })).toEqual([{ tag: '2.5', level: 'minor' }]);
  });
  it('images from one publisher on one tag move together, to a tag they all have', () => {
    const groups = lockstepGroups({
      server: { repository: 'ghcr.io/immich-app/immich-server', tag: 'v3.2.1' },
      'machine-learning': { repository: 'ghcr.io/immich-app/immich-machine-learning', tag: 'v3.2.1' },
      database: { repository: 'ghcr.io/immich-app/postgres', tag: '14-vectorchord0.4.3-pgvectors0.2.0' },
      redis: { repository: 'valkey/valkey', tag: '8.1.3-bookworm' },
    });
    expect(groups).toEqual([['machine-learning', 'server'], ['database'], ['redis']]);
    const server = newerTags('v3.2.1', ['v3.3.0', 'v3.3.1', 'v3.3.2']);
    const ml = newerTags('v3.2.1', ['v3.3.0', 'v3.3.1']);
    expect(commonCandidates([server, ml])[0]).toEqual({ tag: 'v3.3.1', level: 'minor' });
  });
  it('rewrites whole versions in free text, never part of a longer one', () => {
    expect(replaceVersions('Open WebUI v0.11.3 with Ollama 0.34.0 (CPU inference).', [{ from: '0.11.3', to: '0.12.0' }, { from: '0.34.0', to: '0.40.3' }])).toBe('Open WebUI v0.12.0 with Ollama 0.40.3 (CPU inference).');
    expect(replaceVersions('1.2.30 and 11.2.3 and 1.2.3.4 stay; 1.2.3 moves', [{ from: '1.2.3', to: '1.2.4' }])).toBe('1.2.30 and 11.2.3 and 1.2.3.4 stay; 1.2.4 moves');
  });
  it('updates.json is checked strictly', () => {
    expect(checkPolicy({ schemaVersion: 1, apps: { immich: { hold: ['database'], note: 'Immich names its database image per release' } } }).apps?.['immich']?.hold).toEqual(['database']);
    expect(() => checkPolicy({ schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => checkPolicy({ schemaVersion: 1, apps: { immich: { hodl: [] } } })).toThrow(/unknown key hodl/);
    expect(() => checkPolicy({ schemaVersion: 1, apps: { x: { skip: '' } } })).toThrow(/must say why/);
    expect(() => checkPolicy({ schemaVersion: 1, apps: { x: { match: { web: '(' } } } })).toThrow(/regular expression/);
  });
});

describe('a Postgres major in a tag (harbor-apps #46)', () => {
  it('keeps pgNN in the shape, so 0.8.7-pg15 never moves to 0.8.7-pg18', () => {
    expect(tagShape('0.8.7-pg15')).toEqual({ key: '#.#.#-pg15', nums: [0, 8, 7] });
    expect(newerTags('0.8.7-pg15', ['0.8.7-pg18', '0.8.8-pg18', '0.8.8-pg15', 'pg15', '0.9.0-pg16'])).toEqual([{ tag: '0.8.8-pg15', level: 'minor' }]);
    expect(newerTags('2.17.2-pg16', ['2.18.0-pg17', '2.17.3-pg16'], { withinMajor: true })).toEqual([{ tag: '2.17.3-pg16', level: 'patch' }]);
  });

  it('does not treat digits after other letters as a Postgres major', () => {
    expect(tagShape('v1.2-jpg3')?.nums).toEqual([1, 2, 3]);
  });

  it('counts pgvector as a data store', () => {
    expect(isDataStore('pgvector/pgvector')).toBe(true);
  });
});
