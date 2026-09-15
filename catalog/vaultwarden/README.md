# Vaultwarden

Lightweight password manager server compatible with the Bitwarden apps and browser extensions.

## What Harbor does

- Runs Vaultwarden on 127.0.0.1 with its data in a retained volume.
- Tells Vaultwarden its published address (DOMAIN) so links, WebAuthn and the apps work.

## Storage

- `data`: Vault database, attachments and icons cache.
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open the web vault and create your account.
2. Publish the app (tailnet or public) and point the Bitwarden apps at that address (Settings, Self-hosted). The apps require HTTPS, which publishing provides.
3. Once everyone has an account, set SIGNUPS_ALLOWED to false: this needs a package revision or the admin page; see the notes.

## Notes

- The admin page is disabled (no ADMIN_TOKEN). This keeps the default installation simple; a later revision may add an opt-in.
- Back up the data volume regularly; it contains your encrypted vault.

Upstream: https://github.com/dani-garcia/vaultwarden
