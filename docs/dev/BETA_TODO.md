# Before the beta

Written 2026-09-21 against v0.16.2 (tree clean, CI + release green, local suites green: unit 125,
integration 123 + 3 live-Docker skipped, e2e 25, `pnpm audit --prod` clean, no open issues).
Tick items here as they land; each one that ships gets its usual DECISIONS row + PROGRESS phase.

Beta means: a stranger can install the current release on a fresh Ubuntu 24.04 box from the
README one-liner, put real data in it, and nothing Harbor says about that data is untrue.

## Must (blocks the beta tag)

- [ ] **Tell the truth about encryption.** The wizard says "The whole app (including its
      database) is installed encrypted here" (`web/src/app/dialogs.tsx`), but app volumes are
      plain bind mounts at `<home>/volumes/<claim>` outside the AES-256-GCM `vault/`
      (`src/storage/app-home.ts`); fscrypt is "stage 4", unbuilt (`docs/design/APP_HOMES.md`).
      Decide one of: (a) build stage 4 (fscrypt on ext4 `encrypt` feature, key from the vault
      master key) so the claim becomes true, or (b) reword every "encrypted" string in the console,
      CLI, operator guide §4a2 and APP_HOMES.md to "sealed metadata, portable app" and say plainly
      that app data on the drive is readable by anyone holding the drive. (b) is a day; (a) is a
      round. Do not ship the beta with the current wording.
- [ ] **Fresh-machine acceptance run of the current release.** Last A01–A16 run and catalog
      qualification are from 2026-09-15 (Harbor 0.8.x era); 0.9 → 0.16 were verified only as
      incremental upgrades on carlos-desktop. Rebuild `harbor-test`, install via the public
      one-liner (`install.sh` → latest release), finish the browser setup wizard, run
      `pnpm test:vm -- --fresh --exposure` (check the runner still matches the setup-code flow)
      and `node scripts/vm/qualify-catalog.mjs --fresh`; refresh `docs/VERIFICATION.md` §3/§4
      (still lists Harbor 0.10.0 as the qualified version) and the evidence dir.
- [ ] **Self-update rollback.** `harbor self-update apply` downloads, verifies and runs the new
      release's `bootstrap --yes` (`src/bootstrap/selfupdate-apply.ts`); a failed daemon start
      leaves apps running but the console gone, with no revert. Keep the previous release dir,
      poll `/healthz` after restart, revert automatically on failure, and record the outcome in
      `updates/status.json`. Minimum acceptable fallback: a documented
      `sudo harbor self-update apply --to <previous>` downgrade that is proven to work with a newer
      schema DB (currently unverified: schema is v7, older binaries may refuse).
- [ ] **Recovery story for real data.** Two concrete holes: `harbor enroll --reset` destroys the
      sealed machine key (`src/maintenance.ts`), so data-folder apps lose their only key; and there
      is no export of Harbor-owned state + recovery secrets (the spec's own preserved backup
      boundary). Ship `harbor recovery export` (state DB, sealed machine key, instance secrets,
      app-home envelopes; passphrase-wrapped) + `harbor recovery import`, warn loudly in
      `enroll --reset`, and write an "if this machine dies" page in the operator guide covering
      managed volumes (not backed up by Harbor), data-folder apps (need the recovery bundle) and
      drive apps (portable via passphrase/adopt).

## Should (cheap, do before inviting testers)

- [ ] **Docs accuracy pass.** README status still says v0.12.5; `docs/AI_CONTEXT.md` says
      0.14.0 / next decision 94; operator guide §8 still says disk formatting is "blocked on
      hardware"; PROGRESS "Status" paragraph stops at 0.14.0; VERIFICATION §4 qualified Harbor
      0.10.0. Rewrite them once against the release being tagged.
- [ ] **Minimum hardware in the requirements table** (operator guide §1): RAM/disk floor, and
      a per-app note for the heavy ones (Immich, Open WebUI + Ollama, Nextcloud).
- [ ] **Headless reboot behaviour is visible.** Encrypted apps stay locked after a reboot until
      the first console login (BFU, `src/auth/machine-holder.ts`); on a headless box a power cut
      means Immich is down until someone logs in. Put it in the README "Status"/guide §4a2 in
      plain words, and decide whether a keyfile/TPM auto-unlock is a beta or a 1.0 item.
- [ ] **Beta-tester plumbing.** `SECURITY.md` (how to report, what the trust boundary is),
      `.github/ISSUE_TEMPLATE/bug.md` asking for the diagnostics output, and a
      `harbor diagnostics` command (versions, `systemctl status`, journal tail, redacted
      instance summary, disk/mounts) that testers can paste. Add a "Report a problem" line to
      guide §7.
- [ ] **Beta version + release notes.** Tag as `0.17.0-beta.1` (or whatever the encryption
      decision bumps it to); the release workflow uses `generate_release_notes`, so write a
      hand-crafted "What to expect / what not to trust yet" section into the GitHub Release body
      after CI publishes it.

## Explicitly deferred (Carlos, 2026-09-21)

- **No LICENSE file until 1.0.0** or until Carlos says otherwise (decision 100). The repo stays
  public and all-rights-reserved by default; do not add one autonomously.
- Backups of application data, multi-user/SSO, LAN HTTPS, ARM builds: unchanged, see `docs/FUTURE.md`.
