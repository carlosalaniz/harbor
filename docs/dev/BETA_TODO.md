# Before the beta

Written 2026-09-21 against v0.16.2 (tree clean, CI + release green, local suites green: unit 125,
integration 123 + 3 live-Docker skipped, e2e 25, `pnpm audit --prod` clean, no open issues).
Shipped 2026-09-21 as v0.17.0-beta.1 (decision 101, PROGRESS phase 27): local suites green
(unit 139, integration 127 + 3 live-Docker skipped, e2e 25, openapi 75 paths).
Followed by v0.17.0-beta.2 (decision 103, real kernel sealing — beta.1 had only logged it) and
v0.17.0-beta.3 (decision 104, same-password silent unlock) on 2026-09-21/22: unit 149,
integration 131 + 3 skipped, e2e 25. From 2026-09-23 the beta is `0.17.0` (decision 108), so the plain
one-liner and the self-update feed pick it up without a pin.
Tick items here as they land; each one that ships gets its usual DECISIONS row + PROGRESS phase.

Beta means: a stranger can install the current release on a fresh Ubuntu 24.04 box from the
README one-liner, put real data in it, and nothing Harbor says about that data is untrue.

## Must (blocks the beta tag)

- [x] **Tell the truth about encryption.** Per-app fscrypt sealing (v2 policy, raw_key protector
      = vault master key via root oneshot; format `-O encrypt` + `fscrypt setup`; fake no-op in
      tests/dev) + dual-key homes (passphrase + 12-word recovery, format v2). (decision 101)
      **Correction (decision 103, 0.17.0-beta.2):** beta.1 only *logged* `sealing skipped` (the
      root helper ran unprivileged) and installed plaintext. Sealing is now root-only through
      `harbor-app-crypto@`, mandatory (hard failure), verified live with a Docker bypass
      (ciphertext + ENOKEY while locked) and a reboot re-lock. The wizard's claim is true now.
- [ ] **Fresh-machine acceptance run of the current release.** Last A01–A16 run and catalog
      qualification are from 2026-09-15 (Harbor 0.8.x era); 0.9 → 0.16 were verified only as
      incremental upgrades on home-server. Rebuild `harbor-test`, install via the public
      one-liner (`install.sh` → latest release), finish the browser setup wizard, run
      `pnpm test:vm -- --fresh --exposure` (check the runner still matches the setup-code flow)
      and `node scripts/vm/qualify-catalog.mjs --fresh`; refresh `docs/VERIFICATION.md` §3/§4
      (still lists Harbor 0.10.0 as the qualified version) and the evidence dir.
      (Needs a droplet — not run locally; everything else in this list is done.)
- [x] **Self-update rollback.** Snapshot + `/healthz` poll + automatic restore (`rolled-back`
      state) + documented manual downgrade. (decision 101)
- [x] **Recovery story for real data.** `harbor recovery export` + `harbor recovery import`
      (passphrase-wrapped) + loud `enroll --reset` gate + guide §4f "if this machine dies".
      (decision 101)

## Should (cheap, do before inviting testers)

- [x] **Docs accuracy pass.** README status → beta, AI_CONTEXT versions/counts, guide §8 format
      line fixed. (VERIFICATION §4 still lists 0.10.0 — refreshes with the fresh-machine run above.)
- [x] **Minimum hardware in the requirements table** (operator guide §1): RAM/disk floor, and
      a per-app note for the heavy ones (Immich, Open WebUI + Ollama, Nextcloud).
- [x] **Headless reboot behaviour is visible.** README Status + guide §4a2/§5 in plain words;
      keyfile/TPM auto-unlock deferred to 1.0. (decision 101)
- [x] **Beta-tester plumbing.** `SECURITY.md`, `.github/ISSUE_TEMPLATE/bug.md`, `harbor diagnostics`
      + `GET /v1/system/diagnostics` (redacted), guide §7 "Report a problem" line. (decision 101)
- [x] **Beta version + release notes.** The beta is `0.17.0` (decision 108: an ordinary tag so the
      installer and self-update pick it); `docs/releases/v0.17.0.md` carries "what to expect / what
      not to trust yet" and becomes the GitHub release body. Withdrawal of pre-0.17.0 and beta.N
      releases pending Carlos's confirmation.

## Explicitly deferred (Carlos, 2026-09-21)

- **No LICENSE file until 1.0.0** or until Carlos says otherwise (decision 100). The repo stays
  public and all-rights-reserved by default; do not add one autonomously.
- Backups of application data, multi-user/SSO, LAN HTTPS, ARM builds: unchanged, see `docs/FUTURE.md`.
