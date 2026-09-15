export const ID_PATTERN = '^[a-z][a-z0-9-]{0,62}$';
export const ENV_KEY_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$'; // POSIX names; mixed case is common (JELLYFIN_PublishedServerUrl, FORGEJO__server__ROOT_URL)
export const REVISION_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
export const DIGEST_PATTERN = '^sha256:[a-f0-9]{64}$';
// repository@sha256:<64 hex>; repositories are lowercase with optional registry host and path.
export const IMAGE_REF_PATTERN = '^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$';
export const RELATIVE_PATH_PATTERN = '^/[A-Za-z0-9._~/-]*$';
export const ABSOLUTE_CONTAINER_PATH_PATTERN = '^/[^\\0]*[^/\\0]$';
export const DURATION_PATTERN = '^[0-9]{1,6}(ms|s|m|h)$';
export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const SHA256_HEX_PATTERN = '^[a-f0-9]{64}$';

export const ID_RE = new RegExp(ID_PATTERN);
export const ENV_KEY_RE = new RegExp(ENV_KEY_PATTERN);
export const IMAGE_REF_RE = new RegExp(IMAGE_REF_PATTERN);
export const UUID_RE = new RegExp(UUID_PATTERN);

// Any `$` that begins a Compose interpolation expression (`${VAR}`, `$VAR`, `$$`).
export const INTERPOLATION_RE = /\$(?=[{A-Za-z_$])/;

export function parseDuration(value: string): number | null {
  const m = /^([0-9]{1,6})(ms|s|m|h)$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    default: return null;
  }
}
