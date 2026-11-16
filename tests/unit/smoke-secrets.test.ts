import { describe, expect, it } from 'vitest';
import { smokeSecrets } from '../../scripts/smoke-secrets.js';

describe('smokeSecrets', () => {
  it('gives a required operator secret a throwaway value at least minLength long', () => {
    const v = smokeSecrets([{ id: 'key', source: 'operator', minLength: 40 }]);
    expect(Object.keys(v)).toEqual(['key']);
    expect(v.key).toMatch(/^Smoke-[0-9a-f]+$/);
    expect(v.key!.length).toBeGreaterThanOrEqual(40);
  });

  it('leaves optional operator secrets empty, as most installs do', () => {
    expect(smokeSecrets([{ id: 'relay', source: 'operator', optional: true }, { id: 'pw', source: 'generated' }])).toEqual({});
  });
});
