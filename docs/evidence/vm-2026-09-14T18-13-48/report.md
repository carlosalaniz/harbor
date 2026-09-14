# Live VM run vm-2026-09-14T18-13-48

- Target: digitalocean droplet 600403086 (143.198.73.104) ({"kind":"digitalocean","dropletId":600403086,"size":"s-4vcpu-8gb","image":"ubuntu-24-04-x64","region":"sfo3"})
- Archive: harbor-0.1.0-linux-x64.tar.gz
- Fresh VM: true · reboot test: true
- Versions: {"ubuntu":"Ubuntu 24.04.4 LTS","arch":"x86_64","systemd":"systemd 255 (255.4-1ubuntu8.16)","docker":"29.8.0","compose":"5.5.1","node":"v24.12.0","harbor":"0.1.0"}
- Started 2026-09-14T18:13:48.903Z, finished 2026-09-14T18:23:27.364Z

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| A01 | Clean VM bootstrap without Node/npm; re-run preserves identity/admin/app state | **PASS** | VM rebuilt to a fresh image before this run<br>fixture: Cockpit pre-installed from Ubuntu repos before bootstrap (tests binding an existing tool)<br>Docker 29.8.0 / Compose 5.5.1 installed by bootstrap; Node v24.12.0 bundled<br>bootstrap re-run kept installation id and administrator |
| A02 | CLI and UI show three real pinned packages; invalid package hash/schema rejected before effects | **PASS** | tampered compose.yaml -> catalog unavailable + plan 422 INVALID_PACKAGE, zero Docker effects |
| A03 | Excalidraw + BentoPDF coexist; representative browser actions; installing B does not recreate A | **PASS** | Excalidraw rectangle drawn and exported as PNG (download)<br>BentoPDF merged two PDFs into a 2-page PDF (download)<br>Excalidraw container ids/creation times unchanged by BentoPDF install |
| A04 | Second Excalidraw has distinct project/network/ports; a fourth supported-profile package needs no engine branch | **PASS** | second Excalidraw: distinct UUID, project network and host port<br>fourth package (package files + index only) installed and answered; engine untouched |
| A05 | Occupied port/name or conflicting foreign resource fails safely; no foreign listener/container is stopped | **PASS** | sentinel container occupies 127.0.0.1:18084; planner skipped it<br>duplicate name -> 409 NAME_CONFLICT<br>sentinel still running with the same id |
| A06 | Refresh, logout, CLI disconnect and duplicate submission do not cancel/duplicate an accepted operation | **PASS** | same key -> same operation id; different key on consumed plan -> 409 IDEMPOTENCY_CONFLICT<br>UI reload required login, then showed the single accepted instance |
| A07 | Expired/stale plan and reused key with different request are rejected; same request returns original | **PASS** | stale plan (generation changed) -> 409 STATE_CHANGED<br>reused key with different plan -> 409 IDEMPOTENCY_CONFLICT; same request -> original operation<br>plan expiry (15 min) is covered by tests/integration/install.test.ts with a controlled clock |
| A08 | Stop/start/remove acts on one instance only; retains persistence; tools and sentinel unchanged | **PASS** | stop/start/remove on pdf-b left Excalidraw, Portainer and the sentinel untouched<br>pdf-b retained with its name and port allocation |
| A11 | n8n/PostgreSQL installs; owner setup and credentialed workflow execution; two copies have separate volumes/keys | **FAIL** | page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:18086/setup
Call log:
  - navigating to "http://localhost:18086/setup", waiting until "networkidle"
 |
| A12 | Remove/reinstall the exact n8n instance preserves workflow and credential; missing volume blocks without replacement | **FAIL** | page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:18086/signin
Call log:
  - navigating to "http://localhost:18086/signin", waiting until "networkidle"
 |
| A10 | Failed/interrupted install shows needs_action, retains scope, no blind replay; Docker unavailable is not healthy | **FAIL** | harbor doctor exited 4:  {
  "url": "http://localhost:18000",
  "live": false,
  "loggedIn": true,
  "system": null,
  "authError": null
}
 |
| A13 | UI login/logout, bearer auth, Host/Origin/content type controls; no secrets in DTOs or browser storage | **FAIL** | fetch failed |
| A14 | Cockpit and Portainer bootstrapped with approval; onboarding works; real Open links; absent/external tools honest | **FAIL** | harbor tools exited 4:  {
  "error": {
    "code": "STATE_UNAVAILABLE",
    "message": "cannot reach http://localhost:18000: AggregateError",
    "nextAction": "Is the Harbor daemon running? Check `systemctl status harbor` or your SSH port forward."
  }
}
 |
| A09 | Daemon restart leaves apps running; host reboot returns desired-running apps; intentional stop stays stopped | **FAIL** | harbor list exited 4:  {
  "error": {
    "code": "STATE_UNAVAILABLE",
    "message": "cannot reach http://localhost:18000: AggregateError",
    "nextAction": "Is the Harbor daemon running? Check `systemctl status harbor` or your SSH port forward."
  }
}
 |
| A15 | Package traversal/aliases/duplicate keys/interpolation/undeclared mounts/privileges rejected; malformed API bodies never execute | **FAIL** | fetch failed |
| A16 | Build artifact installs and reproduces the full section-1 demo with recorded results | **FAIL** | run started from a rebuilt VM<br>failed: A09, A10, A11, A12, A13, A14, A15 |

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
