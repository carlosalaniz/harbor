# Live VM run vm-2026-09-15T03-57-13

- Target: digitalocean droplet 600403086 ({"kind":"digitalocean","dropletId":600403086,"size":"s-4vcpu-8gb","image":"ubuntu-24-04-x64","region":"sfo3"})
- Archive: harbor-0.1.0-linux-x64.tar.gz
- Fresh VM: false · reboot test: false
- Versions: {}
- Started 2026-09-15T03:57:13.120Z, finished 2026-09-15T03:57:27.416Z

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| B01 | Exposure providers bootstrapped with approval; tool cards honest; re-run idempotent | **PASS** | proxy: installed/reachable<br>tailscale: setup_required/reachable — Node harbor-test.tail7d0db4.ts.net is logged in, but HTTPS certificates are not enabled for the tailnet. Enable MagicDNS and HTTPS in the Tailscale admin console (DNS settings).<br>bootstrap re-run with providers succeeded (idempotent) |
| B02 | Tailnet exposure of Excalidraw (same port) and B03 Harbor UI on the tailnet | **BLOCKED** | BLOCKED: Tailscale node not enrolled/HTTPS-enabled on the VM (setup_required: Node harbor-test.tail7d0db4.ts.net is logged in, but HTTPS certificates are not enabled for the tailnet. Enable MagicDNS and HTTPS in the Tailscale admin console (DNS settings).). Provide HARBOR_TS_AUTHKEY (a tailnet auth key) and enable MagicDNS+HTTPS in the admin console to run B02/B03 live. Engine behaviour is covered by tests/integration/exposure.test.ts. |

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
