import { isAlias, isCollection, isMap, isPair, isScalar, isSeq, parseAllDocuments, type Node, type Pair } from 'yaml';
import { HarborError } from '../errors.js';

export const MAX_YAML_BYTES = 256 * 1024;
export const MAX_YAML_DEPTH = 32;

// Restricted YAML: one document, YAML 1.2 core schema, unique keys, no aliases/anchors,
// no explicit tags, bounded size and nesting, finite plain-decimal numbers, string keys only.
export function parseRestrictedYaml(bytes: Buffer, label: string): unknown {
  if (bytes.byteLength > MAX_YAML_BYTES) {
    throw new HarborError('INVALID_PACKAGE', `${label}: exceeds ${MAX_YAML_BYTES} bytes`);
  }
  if (bytes.includes(0)) {
    throw new HarborError('INVALID_PACKAGE', `${label}: contains NUL bytes`);
  }
  const text = bytes.toString('utf8');
  if (text.includes('�')) {
    throw new HarborError('INVALID_PACKAGE', `${label}: not valid UTF-8`);
  }
  const docs = parseAllDocuments(text, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    merge: false,
    strict: true,
    logLevel: 'silent',
    prettyErrors: false,
  });
  if (docs.length !== 1) {
    throw new HarborError('INVALID_PACKAGE', `${label}: expected exactly one YAML document, found ${docs.length}`);
  }
  const doc = docs[0]!;
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length) {
    throw new HarborError('INVALID_PACKAGE', `${label}: ${problems[0]!.message.split('\n')[0]}`, {
      details: problems.map((p) => p.message.split('\n')[0]!),
    });
  }
  if (!isMap(doc.contents)) {
    throw new HarborError('INVALID_PACKAGE', `${label}: root must be a mapping`);
  }
  walk(doc.contents, 1, label);
  return doc.toJS({ mapAsMap: false, maxAliasCount: 0 });
}

function walk(node: Node | Pair | null, depth: number, label: string): void {
  if (node === null) return;
  if (depth > MAX_YAML_DEPTH) {
    throw new HarborError('INVALID_PACKAGE', `${label}: nesting deeper than ${MAX_YAML_DEPTH}`);
  }
  if (isPair(node)) {
    const key = node.key as Node | null;
    if (!isScalar(key) || typeof key.value !== 'string') {
      throw new HarborError('INVALID_PACKAGE', `${label}: mapping keys must be plain strings`);
    }
    walk(key, depth, label);
    walk(node.value as Node | null, depth, label);
    return;
  }
  if (isAlias(node)) {
    throw new HarborError('INVALID_PACKAGE', `${label}: YAML aliases are not allowed`);
  }
  if ((node as { anchor?: string }).anchor) {
    throw new HarborError('INVALID_PACKAGE', `${label}: YAML anchors are not allowed`);
  }
  if ((node as { tag?: string }).tag) {
    throw new HarborError('INVALID_PACKAGE', `${label}: explicit YAML tags are not allowed`);
  }
  if (isScalar(node)) {
    const v = node.value;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new HarborError('INVALID_PACKAGE', `${label}: non-finite numbers are not allowed`);
      const src = node.source ?? '';
      if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(src)) {
        throw new HarborError('INVALID_PACKAGE', `${label}: only plain decimal numbers are allowed (got ${src})`);
      }
    } else if (typeof v === 'bigint') {
      throw new HarborError('INVALID_PACKAGE', `${label}: integer out of range`);
    }
    return;
  }
  if (isMap(node)) {
    for (const item of node.items) walk(item, depth + 1, label);
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) walk(item as Node, depth + 1, label);
    return;
  }
  if (isCollection(node)) {
    throw new HarborError('INVALID_PACKAGE', `${label}: unsupported YAML collection`);
  }
}
