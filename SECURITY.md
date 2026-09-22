# Security policy

Harbor is a **trusted local preview**: one administrator, one Ubuntu machine, one daemon with
Docker (root-equivalent) authority. This policy describes what that means for reporting problems.

## Trust boundary (read this first)

- The `harbor` service user is in the `docker` group and is therefore **root-equivalent**.
  The API is not a sandbox against anyone with Docker or root access on the machine.
- Loopback by default; LAN mode, tailnet and public HTTPS are opt-in providers.
  The console itself is loopback + tailnet only, never public.
- Application secrets live in `/var/lib/harbor/instances/<uuid>/secrets/` (0600) and appear in
  plaintext in the private generated Compose file. That is deliberate for the trusted local
  preview; there is no encrypted vault for them.
- Whole-app encryption (install locations) protects data **at rest on the drive**: a locked app
  is ciphertext (fscrypt v2 in the kernel, one key per app) until the passphrase, recovery key or
  this machine's login-sealed key unlocks it — while locked, root and Docker read ciphertext too.
  Once unlocked, it does not protect against root or Docker admins on the running machine.

## How to report a security issue

**Do not open a public issue for anything that could be a vulnerability.** Email the maintainer
directly (see the repository owner) with:

1. What you did, step by step, and what you expected vs what happened.
2. The output of `harbor diagnostics` (redacted by design: versions, host facts, app states,
   disks, log tail — no secrets, tokens, passphrases or credentials).
3. Whether the machine is a fresh install or an upgrade, and the Harbor version (`harbor doctor`).

You will get a reply, not an automated ticket. If the report is confirmed, the fix ships in the
next release and the release notes say what happened — no silent patches.

## What counts as in scope

- Bypassing authentication (logging in without the password / setup code / second factor).
- Reading another origin's data through the console (Host/Origin/CSP bypass).
- Harbor touching Docker objects, files or drives it does not own (ownership violations).
- Unlocking an encrypted app without its passphrase or recovery key.

Out of scope: anything requiring root or Docker access on the machine (that is already full
control by design), social engineering, and vulnerabilities in the apps themselves (report those
upstream; Harbor pins their images but does not audit them).

## For beta testers

Run `harbor diagnostics` and paste the whole block into your bug report (see
`.github/ISSUE_TEMPLATE/bug.md`). It never contains secrets — if you think it does, that is
itself a security bug: report it privately per above.
