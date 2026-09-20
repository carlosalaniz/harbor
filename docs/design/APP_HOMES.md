# Design addendum: portable app homes (Mac-app-like bundles)

**Status:** foundation built (2026-09-20, decision 91): `src/storage/app-home.ts` +
`tests/unit/app-home.test.ts`. Adopt/install-location flows are follow-ups; this
document pins the on-disk format and the key model so later stages need no rework.

## 1. Problem

Managed volumes live under Docker's data-root on the system disk. On a machine
with tiny onboard storage the operator is stuck: databases cannot use the
per-claim folder picker (wrong tool — binds weld one path to whatever
filesystem happens to be there, and Harbor never chowns operator folders), and
there is no way to move an app to another disk or another Harbor machine.

## 2. Answer: one folder per app, self-describing, optionally sealed

An app home is a single folder — `<drive>/harbor-apps/<name>/` — that carries
everything needed to adopt the app on any Harbor machine:

```
<name>/
  manifest.json   plaintext descriptor (identity, package, encryption envelope)
  vault/          encrypted payload (file bytes AND names are ciphertext)
```

The manifest is **deliberately plaintext**: a locked app still shows its name,
package id and revision in the console (the "locked" tile with a padlock). The
actual encrypted folder sits *inside* so the UI can display the app without
unlocking it. Secrets never live in the manifest.

## 3. Key model (two wrappings, one master key)

Per app, one random 256-bit master key, wrapped twice:

1. **Machine wrapping** — AES-256-GCM with a per-installation key, stored in
   Harbor state (`<stateDir>/keys/`, never on the drive). Powers silent
   auto-adopt at launch: Harbor walks mounted drives, finds app homes, tries
   its own wrapping, unlocks, starts (subject to the auto-start policy).
2. **Passphrase wrapping** — scrypt (same N/r/p profile as operator passwords)
   → AES-256-GCM KEK, stored **in the app home manifest**. The portability
   path: new machine → adopt → password prompt → unwrap → the new machine adds
   its own machine wrapping so future launches are silent.

At install-to-drive time the operator chooses a passphrase (or a generated
recovery key, shown once — the existing shown-once credential pattern). Machine
dies + passphrase forgotten = data gone; the recovery key is the honest
mitigation.

## 4. Lifecycle

- **Launch / insert**: the observer finds app homes → own machine key works →
  unlock, adopt/start silently. Own key absent or fails → tile appears
  **locked** with the drive name; click → passphrase prompt → adopt plan.
- **Name collision**: display-name suffix ` (2)`, ` (3)` — display only;
  identity stays the instance UUID from the manifest, ports re-allocate locally.
- **Release** (unplug ceremony): stop app, mark the home cleanly stopped. The
  machine wrapping is kept so re-plugging into the same machine stays silent.
  Adopting a home that is not marked released requires an explicit override
  ("machine A is dead") — the split-brain rule.
- **Locked is a quiet state**, not an alarm: a padlock tile, not `needs_action`.

## 5. Machine key sealed by the login password (BFU/AFU, like phones)

The per-installation machine key never sits on disk in the clear. It is sealed
with a KEK derived from the administrator's login password (scrypt, same
profile) and only the sealed blob is stored — in the settings table
(`security.machineKey`, JSON), so no migration is needed.
`src/auth/machine-key.ts` holds the pure key handling; callers own persistence
and memory lifetime.

- **BFU (before first unlock):** daemon starts, the blob is on disk, the key is
  NOT in memory. App homes show as locked; nothing auto-unlocks. The first
  successful login derives the KEK, unseals the key, and holds it in memory
  only.
- **AFU (after first unlock):** the key lives in memory. Logins verify against
  the stored password hash as usual; app homes auto-adopt silently. A daemon
  restart returns to BFU.
- **Password change** re-seals the live key under the new password (the change
  flow already requires the current password). A password *reset* without the
  old password destroys the sealed blob — app homes stay recoverable through
  their own passphrases, which is the honest recovery story.
- Stealing the disk gets ciphertext twice over (sealed machine key + sealed
  app vaults). Stealing a live machine gets what root always gets — consistent
  with the trust model.

## 6. Hard constraints

- **Removable media used for app installs must be ext4** (with the `encrypt`
  feature for the later fscrypt stage). The picker only offers POSIX
  filesystems; exFAT/NTFS are greyed out with a one-line reason. A Postgres on
  exFAT is corruption, not portability.
- **ext4-only means Linux-only drives.** The drive is unreadable on macOS /
  Windows — acceptable, since the payload is ciphertext anyway. The UI says so.
- Root on a live machine can always read keys — consistent with the trust model
  (the `harbor` service user is root-equivalent; the API is not a sandbox
  against root).

## 7. Stages

1. **Foundation (built, decision 91):** `src/storage/app-home.ts` — manifest
   format v1, scrypt+AES-256-GCM envelope, machine wrapping, payload seal/open
   helpers, `scanAppHomes` for drive walks. Pure module: no Docker, no DB.
   Plus `src/auth/machine-key.ts` — the sealed machine keystore (BFU/AFU).
2. **Install-location:** per-instance location choice at install time writing
   the full home structure from day one (so no migration later).
3. **Adopt-from-drive:** observer scan → locked/unlocked tiles → adopt plan
   (validate package snapshot like a zip import, allocate ports, repoint
   volumes, pull by digest, start, verify readiness).
4. **Kernel sealing (fscrypt):** replace or complement the AES payload layer
   with ext4 native directory encryption once the format flow (FUTURE.md) can
   guarantee `-O encrypt`. The manifest + key model above does not change.

## 8. Format reference (v1)

`manifest.json` (0644): `{ format: 1, instanceId (uuid), packageId,
packageRevision, displayName, createdAt (RFC3339), harborVersion, driveId
(app-generated, travels with restores), vault: "vault", encryption:
{ algorithm: "aes-256-gcm", passphrase: { N, r, p, keylen, salt, nonce,
wrappedKey, tag (all hex) } } }`. Unknown `format` refuses with "update Harbor".
`vault/` (0700): sealed blobs (`nonce || ciphertext || tag` per payload).
