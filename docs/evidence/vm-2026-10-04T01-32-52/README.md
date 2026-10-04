# Acceptance run vm-2026-10-04T01-32-52

Harbor 0.18.2 on a freshly rebuilt DigitalOcean droplet (Ubuntu 24.04.5), `pnpm test:vm -- --fresh --exposure`.
Proves A01–A16, B01/B04/B05/B07/B09/B10 and C01 live: 23 pass, 0 fail; B02/B03 blocked (no tailnet auth key).
Cited by docs/VERIFICATION.md §3e.
