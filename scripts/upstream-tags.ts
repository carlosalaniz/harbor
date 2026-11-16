// Pure helpers for the catalog's upstream-update bot (decision 175): which newer image tag an app may move
// to, how big the move is, and which services move together. No network, no files: scripts/catalog-upstream.ts
// does the registry reads and the edits.
//
// A tag is compared only with tags of the same shape: the same text with every run of digits replaced, so
// v0.11.3 competes with v0.12.0 but never with v0.12.0-cuda, latest or 2024-nightly. Within a shape the digit
// runs compare as numbers, left to right. A Postgres major written into a tag (pgvector 0.8.7-pg15, timescaledb
// 2.17.2-pg16) is part of the shape, not a number: its data directory only opens with that major, so 0.8.7-pg15
// never moves to 0.8.7-pg18 (harbor-apps #46, Khoj).

export interface TagShape {
  key: string; // the tag with each digit run replaced by '#'
  nums: number[];
}

export function tagShape(tag: string): TagShape | null {
  const parts = tag.split(/(\d+)/);
  const nums: number[] = [];
  let key = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1 && /(^|[^a-z])pg$/i.test(parts[i - 1]!)) key += parts[i];
    else if (i % 2 === 1) {
      const n = Number(parts[i]);
      if (!Number.isSafeInteger(n)) return null;
      nums.push(n);
      key += '#';
    } else key += parts[i];
  }
  return nums.length ? { key, nums } : null;
}

export function compareNums(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export type Level = 'major' | 'minor' | 'patch';
const RANK: Record<Level, number> = { patch: 0, minor: 1, major: 2 };
export const maxLevel = (levels: Level[]): Level | null => (levels.length ? levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : null);

// How big a move from -> to is. 0.x counts one place further (semver: 0.11 -> 0.12 may break things), so
// 0.11.3 -> 0.12.0 is major and 0.11.3 -> 0.11.4 minor; 0.0.x moves are always major.
export function bumpLevel(from: number[], to: number[]): Level | null {
  const i = from.findIndex((n, k) => n !== (to[k] ?? 0));
  if (i < 0) return null;
  const zeros = from[0] === 0 ? (from[1] === 0 ? 2 : 1) : 0;
  const place = i - zeros;
  return place <= 0 ? 'major' : place === 1 ? 'minor' : 'patch';
}

export interface Candidate {
  tag: string;
  level: Level;
}

// Newer tags of the same shape as `current`, best first. withinMajor drops major moves (infrastructure
// services: a database's major version needs a data migration Harbor does not do). `match`, when given, is a
// pattern the new tag must also match (a package's own pin rule from updates.json).
export function newerTags(current: string, available: string[], opts: { withinMajor?: boolean; match?: RegExp } = {}): Candidate[] {
  const cur = tagShape(current);
  if (!cur) return [];
  const out: (Candidate & { nums: number[] })[] = [];
  for (const tag of new Set(available)) {
    const s = tagShape(tag);
    if (!s || s.key !== cur.key || s.nums.length !== cur.nums.length || compareNums(s.nums, cur.nums) <= 0) continue;
    // a project that switched from versions to dates (or an old date tag next to versions) is not an upgrade
    // anyone can judge from the numbers: 2.8.3 -> 2021.11.28 is skipped
    if (cur.nums[0]! < 1900 && s.nums[0]! >= 1900) continue;
    if (opts.match && !opts.match.test(tag)) continue;
    const level = bumpLevel(cur.nums, s.nums);
    if (!level || (opts.withinMajor && level === 'major')) continue;
    out.push({ tag, level, nums: s.nums });
  }
  return out.sort((a, b) => compareNums(b.nums, a.nums)).map(({ tag, level }) => ({ tag, level }));
}

// Images that hold data in a format tied to their major version. They stay on their major whatever role the
// package gives them (a database declared as an application service is still a database).
const DATA_STORE = /(^|\/)(postgres|postgis|pgvector|pgvecto-rs|pgautoupgrade|timescaledb|mariadb|mysql|mongo|redis|valkey|keydb|elasticsearch|opensearch|influxdb|clickhouse-server|couchdb|cassandra|neo4j|etcd)$/;
export const isDataStore = (repository: string): boolean => DATA_STORE.test(repository.replace(/^docker\.io\//, '').replace(/^library\//, ''));

// Services that must move together: images from the same publisher (registry + owner) on the same tag, like
// Immich's server and machine-learning images (both v3.2.1). Each group moves to a tag every member has.
export function lockstepGroups(images: Record<string, { repository: string; tag: string }>): string[][] {
  const groups = new Map<string, string[]>();
  for (const [svc, img] of Object.entries(images)) {
    const owner = img.repository.includes('/') ? img.repository.slice(0, img.repository.lastIndexOf('/')) : img.repository;
    const key = `${owner}\u0000${img.tag}`;
    groups.set(key, [...(groups.get(key) ?? []), svc]);
  }
  return [...groups.values()].map((g) => g.sort());
}

// The candidates every member of a group has, best first (a tag only one of two images published is not taken).
export function commonCandidates(perService: Candidate[][]): Candidate[] {
  if (!perService.length) return [];
  const [first, ...rest] = perService;
  return first!.filter((c) => rest.every((r) => r.some((x) => x.tag === c.tag)));
}

// updates.json at the catalog repository's root: the bot's per-app rules. Every field is optional.
export interface UpdatePolicy {
  schemaVersion: 1;
  defaults?: { minAgeDays?: number };
  apps?: Record<string, { skip?: string; hold?: string[]; match?: Record<string, string>; note?: string }>;
}

export function checkPolicy(value: unknown): UpdatePolicy {
  const fail = (why: string): never => {
    throw new Error(`updates.json: ${why}`);
  };
  if (!value || typeof value !== 'object') fail('not an object');
  const p = value as UpdatePolicy;
  if (p.schemaVersion !== 1) fail('schemaVersion must be 1');
  const known = new Set(['schemaVersion', 'defaults', 'apps', '$comment']);
  for (const k of Object.keys(p)) if (!known.has(k)) fail(`unknown key ${k}`);
  const age = p.defaults?.minAgeDays;
  if (age !== undefined && (!Number.isInteger(age) || age < 0 || age > 60)) fail('defaults.minAgeDays must be a whole number of days, 0 to 60');
  for (const [id, a] of Object.entries(p.apps ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) fail(`app id ${id} is not an app id`);
    for (const k of Object.keys(a)) if (!['skip', 'hold', 'match', 'note'].includes(k)) fail(`apps.${id}: unknown key ${k}`);
    if (a.skip !== undefined && (typeof a.skip !== 'string' || !a.skip.trim())) fail(`apps.${id}.skip must say why`);
    if (a.hold !== undefined && (!Array.isArray(a.hold) || a.hold.some((s) => typeof s !== 'string'))) fail(`apps.${id}.hold must list service names`);
    for (const [svc, re] of Object.entries(a.match ?? {})) {
      try {
        new RegExp(re);
      } catch {
        fail(`apps.${id}.match.${svc} is not a regular expression`);
      }
    }
  }
  return p;
}

// The app version a tag stands for, as scripts/catalog-pin.mjs records it (appVersion): the tag without a "v".
export const tagVersion = (tag: string): string => tag.replace(/^v(?=\d)/, '');

// Replace whole-word occurrences of each old version in free text (release notes, release.version), so
// "Open WebUI v0.11.3 with Ollama 0.34.0" becomes "... v0.12.0 with Ollama 0.40.3". Never inside a longer number.
export function replaceVersions(text: string, moves: { from: string; to: string }[]): string {
  let out = text;
  for (const m of moves) {
    if (!m.from || m.from === m.to) continue;
    const esc = m.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\w.])(v?)${esc}(?![\\w]|\\.\\d)`, 'g'), (_all, v: string) => v + m.to);
  }
  return out;
}
