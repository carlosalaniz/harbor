import { describe, expect, it } from 'vitest';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { HarborError } from '../../src/errors.js';

const parse = (s: string) => parseRestrictedYaml(Buffer.from(s), 'test.yaml');
const rejects = (s: string, re: RegExp) => {
  try {
    parse(s);
  } catch (e) {
    expect(HarborError.is(e, 'INVALID_PACKAGE')).toBe(true);
    expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error('expected rejection');
};

describe('restricted YAML parser', () => {
  it('parses a plain mapping with YAML 1.2 core scalars and no coercion surprises', () => {
    expect(parse('a: 1\nb: "2"\nc: yes\nd: true\ne: [1, x]\nf: 1.5\n')).toEqual({ a: 1, b: '2', c: 'yes', d: true, e: [1, 'x'], f: 1.5 });
  });
  it('rejects duplicate keys', () => rejects('a: 1\na: 2\n', /unique|duplicate/i));
  it('rejects aliases and anchors', () => {
    rejects('a: &x 1\nb: *x\n', /alias|anchor/i);
    rejects('a: &x 1\n', /anchor/i);
  });
  it('rejects merge keys', () => rejects('base: &b {x: 1}\nchild:\n  <<: *b\n', /alias|anchor|merge/i));
  it('rejects explicit tags', () => {
    rejects('a: !!binary AAAA\n', /tag/i);
    rejects('a: !custom foo\n', /tag/i);
    rejects('a: !!str 1\n', /tag/i);
  });
  it('rejects multiple documents', () => rejects('a: 1\n---\nb: 2\n', /exactly one/i));
  it('rejects non-mapping roots', () => {
    rejects('- a\n', /mapping/i);
    rejects('just a string\n', /mapping/i);
  });
  it('rejects non-finite and non-decimal numbers', () => {
    rejects('a: .inf\n', /non-finite|decimal/i);
    rejects('a: .nan\n', /non-finite|decimal/i);
    rejects('a: 0x1F\n', /decimal/i);
    rejects('a: 0o17\n', /decimal/i);
    rejects('a: 1e3\n', /decimal/i);
  });
  it('rejects non-string keys', () => {
    rejects('1: a\n', /plain strings/i);
    rejects('? [a]\n: b\n', /plain strings/i);
    rejects('null: x\n', /plain strings/i);
  });
  it('rejects oversized input and deep nesting', () => {
    rejects('a: ' + 'x'.repeat(256 * 1024), /exceeds/);
    let deep = 'a:';
    for (let i = 0; i < 40; i++) deep += '\n' + ' '.repeat(i + 1) + 'a:';
    deep += ' 1\n';
    rejects(deep, /nesting/i);
  });
  it('rejects NUL bytes and invalid UTF-8', () => {
    rejects('a: b\0', /NUL/);
    try {
      parseRestrictedYaml(Buffer.from([0x61, 0x3a, 0x20, 0xff, 0xfe]), 't');
    } catch (e) {
      expect((e as Error).message).toMatch(/UTF-8/);
    }
  });
});
