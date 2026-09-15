import { describe, expect, it } from 'vitest';
import { dnsState } from '../../src/system/net.js';

describe('domain DNS judgement', () => {
  const here = { v4: '203.0.113.10', v6: null };
  it('recognises records that point here, elsewhere, or nowhere', () => {
    expect(dnsState({ a: ['203.0.113.10'], aaaa: [] }, here).state).toBe('points_here');
    expect(dnsState({ a: ['198.51.100.7'], aaaa: [] }, here)).toMatchObject({ state: 'points_elsewhere' });
    expect(dnsState({ a: [], aaaa: [] }, here)).toMatchObject({ state: 'no_record' });
    expect(dnsState({ a: ['198.51.100.7'], aaaa: [] }, { v4: null, v6: null }).state).toBe('unknown');
    expect(dnsState({ a: [], aaaa: ['2001:db8::1'] }, { v4: null, v6: '2001:db8::1' }).state).toBe('points_here');
  });
});
