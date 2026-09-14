# Live VM run vm-2026-09-14T18-11-09

- Target: digitalocean droplet 600403086 (143.198.73.104) ({"kind":"digitalocean","dropletId":600403086,"size":"s-4vcpu-8gb","image":"ubuntu-24-04-x64","region":"sfo3"})
- Archive: harbor-0.1.0-linux-x64.tar.gz
- Fresh VM: true · reboot test: true
- Versions: {}
- Started 2026-09-14T18:11:09.745Z, finished 2026-09-14T18:11:48.444Z

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| A01 | Clean VM bootstrap without Node/npm; re-run preserves identity/admin/app state | **FAIL** | do-vm rebuild failed |

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
