# seccomp profiles Harbor ships

`browser-sandbox.json` is what the `browser-sandbox` permission renders (decision 201, Harbor 0.45.0):
Docker's default seccomp profile from moby `docker-v29.9.3`
(`vendor/github.com/moby/profiles/seccomp/default.json`, Apache-2.0, Copyright Docker, Inc. and the moby
contributors) with one rule appended at the end of `syscalls`: `clone`, `unshare`, `setns` and `chroot` allowed
without conditions, so a browser's own sandbox can create its namespaces inside the container.

Do not edit it by hand. `node scripts/seccomp-profile.mjs` writes it from a Docker release and prints the hash of the
upstream part; `tests/unit/seccomp.test.ts` checks the file against that hash (`src/planner/seccomp.ts`).
