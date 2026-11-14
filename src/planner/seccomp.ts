// Decision 201: the `browser-sandbox` permission. Harbor ships one seccomp profile (seccomp/browser-sandbox.json,
// written by scripts/seccomp-profile.mjs): Docker's default profile plus one rule that allows clone, unshare, setns
// and chroot, which a browser's own sandbox needs inside a container. AppArmor stays at Docker's default on purpose:
// on Ubuntu 24.04 (kernel.apparmor_restrict_unprivileged_userns=1) an UNCONFINED process loses its capabilities in a
// new user namespace, so `apparmor=unconfined` would break the sandbox instead of helping it.
import { fileURLToPath } from 'node:url';

// <release>/seccomp/browser-sandbox.json (dist/planner/seccomp.js and src/planner/seccomp.ts are both two levels down).
// Compose reads the file when it creates the container and hands its contents to Docker, so a running container
// does not depend on it; /opt/harbor is replaced in place by self-update, so the path stays valid.
export const BROWSER_SANDBOX_PROFILE = fileURLToPath(new URL('../../seccomp/browser-sandbox.json', import.meta.url));

// sha256 of JSON.stringify(Docker's default profile at docker-v29.9.3): the shipped profile minus its last rule must
// hash to this (tests/unit/seccomp.test.ts). Re-run scripts/seccomp-profile.mjs to move to a newer Docker release.
export const BROWSER_SANDBOX_UPSTREAM_SHA256 = '4dc1298afa7676147c1320afa42d72691fc55379ae762b392b56853574a7a38a';
export const BROWSER_SANDBOX_SYSCALLS: readonly string[] = ['clone', 'unshare', 'setns', 'chroot'];

// What Compose gets for a service granted the permission
export const browserSandboxSecurityOpt = (profile: string = BROWSER_SANDBOX_PROFILE): string[] => [`seccomp=${profile}`];
