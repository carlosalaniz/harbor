# Live VM run vm-2026-09-15T04-20-57

- Target: digitalocean droplet 600403086 ({"kind":"digitalocean","dropletId":600403086,"size":"s-4vcpu-8gb","image":"ubuntu-24-04-x64","region":"sfo3"})
- Archive: harbor-0.1.0-linux-x64.tar.gz
- Fresh VM: false · reboot test: false
- Versions: {}
- Started 2026-09-15T04:20:57.240Z, finished 2026-09-15T04:21:50.925Z

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| B02 | Tailnet exposure of Excalidraw (same port) and B03 Harbor UI on the tailnet | **PASS** | Excalidraw at https://harbor-test.tail7d0db4.ts.net:18080/ answered HTTP 200 from the host over the tailnet name; Harbor UI at https://harbor-test.tail7d0db4.ts.net/<br>a second tailnet device was not available to this run; reachability verified from the node itself |

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
