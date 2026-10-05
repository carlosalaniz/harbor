# Acceptance run vm-2026-10-05T01-36-24

Harbor 0.19.0 (the beta build) on a freshly rebuilt DigitalOcean droplet (Ubuntu 24.04), `pnpm test:vm -- --fresh --exposure`.
Proves A01–A16, B01/B04/B05/B07/B09/B10 and C01 live after decisions 121–122: 23 pass, 0 fail; B02/B03 blocked (no tailnet auth key).
Cited by docs/VERIFICATION.md §3e and docs/releases/v0.19.1.md.
