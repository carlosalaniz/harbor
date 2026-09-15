# Console screenshots — v0.6.0 on the live droplet (2026-09-15)

Taken with Playwright through an SSH tunnel after uploading `hello-nginx` revision 1 (pinned from Docker Hub),
installing it, and uploading revision 2. See `docs/VERIFICATION.md` (v0.6.0 section) for the commands and results.

| File | What it shows |
|---|---|
| `01-home-update-available.png` | Home: *1 update available* card with the app, `1 → 2 (1.28)` and its release note; the tile carries the blue ↑ badge |
| `02-drawer-update-banner.png` | App drawer: update banner with Update button |
| `03-review-update-plan.png` | Review update: what stays, the image digest change, warnings, the rollback promise |
| `04-store-your-apps.png` | App Store filtered to *Your apps* with the *Your app · 1.28* badge |
| `05-your-app-page.png` | The uploaded app's page (revision, version, "your own upload", Remove package) |
| `06-upload-dialog.png` | *Your own app* upload dialog with the zip contents explained |
