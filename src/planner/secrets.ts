import type { Manifest } from '../contracts/types.js';
import { HarborError } from '../errors.js';
import type { PlannedSecret } from '../state/repo.js';

// Operator-provided secrets (decision 125): pure rules for what a plan asks for and what a submission
// may carry. Values never enter a plan; they travel with POST /v1/operations and are checked here.

export const OPERATOR_SECRET_MAX = 4096;
// one line of printable text: no NUL, no newlines or other control characters (they would break env files and logs)
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001F\u007F]/;

// What a plan lists for a release's secrets. `ask` marks the operator secrets the submission must (or may)
// carry: at install every operator secret; at update only the ones the new release adds (kept ones stay).
export function plannedSecrets(manifest: Manifest, keep: Set<string> = new Set()): PlannedSecret[] {
  return (manifest.secrets ?? []).map((s) => {
    if (s.source !== 'operator') return { id: s.id };
    const base: PlannedSecret = { id: s.id, source: 'operator', prompt: s.prompt ?? s.id, optional: s.optional ?? false, maxLength: s.maxLength ?? OPERATOR_SECRET_MAX, ...(s.minLength !== undefined ? { minLength: s.minLength } : {}) };
    if (keep.has(s.id)) return base;
    return { ...base, ask: s.optional ? 'optional' : 'required' };
  });
}

// Why a value is not acceptable for this secret (null = fine). Never echoes the value.
export function operatorValueProblem(s: PlannedSecret, value: unknown): string | null {
  const what = `${s.prompt ?? s.id} (secret ${s.id})`;
  if (typeof value !== 'string') return `${what} must be text`;
  if (CONTROL.test(value)) return `${what} must be a single line without control characters`;
  const min = s.minLength ?? 1;
  const max = s.maxLength ?? OPERATOR_SECRET_MAX;
  if (value.length < min) return `${what} must be at least ${min} character${min === 1 ? '' : 's'}`;
  if (value.length > max) return `${what} must be at most ${max} characters`;
  return null;
}

// Checks a submission against the plan. Returns the values to store and the optional ones to clear
// (an empty string clears an optional secret in a configure plan). Throws before anything is created.
export function checkSubmittedSecrets(planned: PlannedSecret[], values: Record<string, string> | undefined): { store: Record<string, string>; clear: string[] } {
  const asked = planned.filter((s) => s.ask);
  const given = values ?? {};
  const store: Record<string, string> = {};
  const clear: string[] = [];
  const how = (id: string) => `Type it in the review dialog, or pass --secret ${id}=@file (or --secret ${id}=- to read it from stdin).`;
  for (const id of Object.keys(given)) {
    if (!asked.some((s) => s.id === id)) throw new HarborError('INVALID_REQUEST', `this plan does not ask for a value for secret ${id}`, { nextAction: asked.length ? `It asks for: ${asked.map((s) => s.id).join(', ')}.` : 'Submit without secrets.' });
  }
  for (const s of asked) {
    const v = given[s.id];
    if (v === undefined) {
      if (s.ask === 'required') throw new HarborError('INVALID_REQUEST', `${s.prompt ?? s.id} is needed (secret ${s.id})`, { nextAction: how(s.id) });
      continue;
    }
    if (v === '' && s.optional) {
      clear.push(s.id);
      continue;
    }
    const problem = operatorValueProblem(s, v);
    if (problem) throw new HarborError('INVALID_REQUEST', problem, { nextAction: how(s.id) });
    store[s.id] = v;
  }
  return { store, clear };
}
