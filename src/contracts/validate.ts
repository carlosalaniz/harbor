import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// One strict Ajv instance shared by package contracts and API route bodies.
// coerceTypes stays false on purpose: "true" is not true, 80 is not "80".
export const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  allowUnionTypes: true,
  strictTuples: false,
});
addFormats.default(ajv);

const cache = new WeakMap<object, ValidateFunction>();

export function compile<T = unknown>(schema: object): ValidateFunction<T> {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(schema, fn);
  }
  return fn as ValidateFunction<T>;
}

export function formatErrors(errors: ErrorObject[] | null | undefined, limit = 8): string[] {
  if (!errors?.length) return [];
  return errors.slice(0, limit).map((e) => {
    const at = e.instancePath || '/';
    const extra =
      e.keyword === 'additionalProperties'
        ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
        : e.keyword === 'enum' || e.keyword === 'const'
          ? ` (allowed: ${JSON.stringify((e.params as { allowedValues?: unknown; allowedValue?: unknown }).allowedValues ?? (e.params as { allowedValue?: unknown }).allowedValue)})`
          : '';
    return `${at}: ${e.message ?? e.keyword}${extra}`;
  });
}
