# Live VM run vm-2026-09-14T23-36-24

- Target: digitalocean droplet 600403086 ({"kind":"digitalocean","dropletId":600403086,"size":"s-4vcpu-8gb","image":"ubuntu-24-04-x64","region":"sfo3"})
- Archive: harbor-0.1.0-linux-x64.tar.gz
- Fresh VM: false · reboot test: false
- Versions: {}
- Started 2026-09-14T23:36:24.093Z, finished 2026-09-14T23:38:31.640Z

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| B04 | Public exposure of n8n as primary: HTTPS via Let's Encrypt, owner login and workflow through the public URL | **PASS** | n8n published at https://harbor-n8n-mu1vtjer.apein.space/ (active); certificate: issuer=C = US, O = Let's Encrypt, CN = YE2<br>primary switched to public: N8N_EDITOR_BASE_URL: "https://harbor-n8n-mu1vtjer.apein.space/" \|       WEBHOOK_URL: "https://harbor-n8n-mu1vtjer.apein.space/"<br>owner login + credentialed workflow through the public URL: success |
| B05 | Public exposure of BentoPDF with basic protection: 401 without credentials, merge works with them | **PASS** | https://harbor-pdf-mu1vu790.apein.space/: 401 without credentials, 200 with; merge in the browser produced a 2-page PDF<br>credentials appeared once in the operation result and not in later DTOs |
| B07 | Provider down: exposures degrade, apps stay fine on loopback; recovery | **PASS** | caddy stopped -> public addresses degraded with a reason, loopback app still 200; caddy started -> active again |
| B10 | Negative: invalid hostname, duplicate hostname, unknown provider state → clear errors, no partial config | **FAIL** | harbor expose 546ed117-61b5-47fc-8d22-d6d517e042d5 --via public --host harbor-dup-mu1vv2c4.apein.space --protect none --yes exited 3:  {
  "error": {
    "code": "INVALID_STATE",
    "message": "bentopdf/web is already exposed via public",
    "nextAction": "Unexpose it first to change hostname or protection."
  }
}
 |
| B09 | Reconfigure primary back to loopback; n8n works locally again; unexpose withdraws routes | **PASS** | primary back to loopback: base URL env re-rendered, workflow ran locally<br>unexpose removed Caddy routes (2 -> 0) |

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
