// The typed-in values `pnpm catalog:smoke` (scripts/catalog-smoke.ts) gives an install, pure so it can be
// unit-tested. A required operator secret gets a throwaway value; an optional one stays empty, as most installs
// leave it. A throwaway in an optional field the app reads as a URL (ntfy's iPhone relay) stops the app, which
// no operator ever sees; an empty optional value is the path every package must survive.
import { randomBytes } from 'node:crypto';

export interface SmokeSecretSpec {
  id: string;
  source?: string | undefined;
  optional?: boolean | undefined;
  minLength?: number | undefined;
}

export function smokeSecrets(specs: readonly SmokeSecretSpec[]): Record<string, string> {
  return Object.fromEntries(
    specs.filter((s) => s.source === 'operator' && !s.optional).map((s) => [s.id, `Smoke-${randomBytes(Math.max(12, Math.ceil((s.minLength ?? 12) / 2))).toString('hex')}`]),
  );
}
