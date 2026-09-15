# Live VM run vm-2026-09-14T23-19-02

- Target: digitalocean droplet 600403086 ({"kind":"digitalocean","dropletId":600403086,"size":"s-4vcpu-8gb","image":"ubuntu-24-04-x64","region":"sfo3"})
- Archive: harbor-0.1.0-linux-x64.tar.gz
- Fresh VM: true · reboot test: true
- Versions: {"ubuntu":"Ubuntu 24.04.4 LTS","arch":"x86_64","systemd":"systemd 255 (255.4-1ubuntu8.16)","docker":"29.8.0","compose":"5.5.1","node":"v24.12.0","harbor":"0.1.0"}
- Started 2026-09-14T23:19:02.270Z, finished 2026-09-14T23:33:56.793Z

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
| A11 | n8n/PostgreSQL installs; owner setup and credentialed workflow execution; two copies have separate volumes/keys | **PASS** | owner created through the n8n setup form (synthetic credentials)<br>credential + workflow created via n8n REST (as the browser does); manual execution status success; fixture saw credentialed call: true<br>second n8n: separate volumes and different generated keys; no PostgreSQL port published<br>Excalidraw still answers |
| A12 | Remove/reinstall the exact n8n instance preserves workflow and credential; missing volume blocks without replacement | **PASS** | remove retained the database volume (same creation time/token) and keys; reinstall reused the exact port and key<br>same owner login, stored workflow and credential worked after reinstall (execution success, fixture credentialed hit true)<br>deleted volume of the second instance -> reinstall needs_action DATA_MISSING, no replacement volume, instance stays retained |
| A10 | Failed/interrupted install shows needs_action, retains scope, no blind replay; Docker unavailable is not healthy | **PASS** | install completed (failed) before the restart took effect; interruption semantics are covered by tests/integration/lifecycle.test.ts<br>Docker stopped -> Harbor stayed active, system docker.available=false, instances unavailable/unknown (none healthy), plan -> 503 DOCKER_UNAVAILABLE; Docker started -> healthy again |
| A13 | UI login/logout, bearer auth, Host/Origin/content type controls; no secrets in DTOs or browser storage | **PASS** | 401/403/422/400 controls verified over the tunnel<br>no secret values or bearer tokens in DTOs or journal<br>browser: no localStorage/sessionStorage/cookies; logout revokes the token<br>login rate limiting (429) is covered by tests/integration/auth.test.ts to avoid locking this run out |
| A14 | Cockpit and Portainer bootstrapped with approval; onboarding works; real Open links; absent/external tools honest | **PASS** | Cockpit external (pre-installed fixture bound without reconfiguring its listener): login with an OS account succeeded<br>Portainer managed: card showed setup_required before; first-run admin created in its own form with the setup token from the container log; card now installed (admin check HTTP 204)<br>tools absent before --with-tools were shown as not_installed with no fake link (A01 evidence)<br>binding a managed tool is rejected (undefined) |
| B01 | Exposure providers bootstrapped with approval; tool cards honest; re-run idempotent | **PASS** | proxy: installed/reachable<br>tailscale: setup_required/unreachable — Installed but not logged in (state NeedsLogin). Run: sudo tailscale up  (then approve the printed login URL).<br>bootstrap re-run with providers succeeded (idempotent) |
| B04 | Public exposure of n8n as primary: HTTPS via Let's Encrypt, owner login and workflow through the public URL | **FAIL** | harbor plan expose 2ebfc7c8-21c1-4973-9170-6fc33b4b9e8b exited 2:  {
  "error": {
    "code": "INVALID_REQUEST",
    "message": "invalid request: /: must have required property 'packageId'",
    "nextAction": "Correct the request and retry.",
    "details": [
      "/: must have required property 'packageId'",
      "/: must NOT have additional properties",
      "/kind: must be equal to constant",
      "/kind: must be equal to one of the allowed values",
      "/: must have required property 'via'",
      "/: must have required property 'via'",
      "/kind: must be equal to constant",
      "/: must have required property 'primary'",
      "/kind: must be equal to constant",
      "/: must match exactly one schema in oneOf"
    ]
  }
}
 |
| B05 | Public exposure of BentoPDF with basic protection: 401 without credentials, merge works with them | **PASS** | https://harbor-pdf-mu1vmmc3.apein.space/: 401 without credentials, 200 with; merge in the browser produced a 2-page PDF<br>credentials appeared once in the operation result and not in later DTOs |
| B07 | Provider down: exposures degrade, apps stay fine on loopback; recovery | **PASS** | caddy stopped -> public addresses degraded with a reason, loopback app still 200; caddy started -> active again |
| B10 | Negative: invalid hostname, duplicate hostname, unknown provider state → clear errors, no partial config | **FAIL** | harbor list exited 255: Connection timed out during banner exchange
Connection to <vm-ip> port 22 timed out
  |
| B02 | Tailnet exposure of Excalidraw (same port) and B03 Harbor UI on the tailnet | **BLOCKED** | BLOCKED: Tailscale node not enrolled/HTTPS-enabled on the VM (setup_required: Installed but not logged in (state NeedsLogin). Run: sudo tailscale up  (then approve the printed login URL).). Provide HARBOR_TS_AUTHKEY (a tailnet auth key) and enable MagicDNS+HTTPS in the admin console to run B02/B03 live. Engine behaviour is covered by tests/integration/exposure.test.ts. |
| A09 | Daemon restart leaves apps running; host reboot returns desired-running apps; intentional stop stays stopped | **PASS** | daemon restart: container ids/creation unchanged; UI recovered after login<br>host reboot (2026-09-14 23:19:26 -> 2026-09-14 23:32:53): desired-running apps healthy again, excalidraw-2 stayed stopped |
| B09 | Reconfigure primary back to loopback; n8n works locally again; unexpose withdraws routes | **FAIL** | harbor primary 2ebfc7c8-21c1-4973-9170-6fc33b4b9e8b loopback --yes exited 3:  {
  "error": {
    "code": "INVALID_STATE",
    "message": "loopback is already the primary address of n8n",
    "nextAction": "The instance is not in a state that allows this operation."
  }
}
 |
| A15 | Package traversal/aliases/duplicate keys/interpolation/undeclared mounts/privileges rejected; malformed API bodies never execute | **PASS** | malformed/oversized/invalid API bodies -> 4xx with zero Docker effects<br>package with privileged/alias/interpolation/bind mount -> unavailable in catalog, plan rejected<br>full parser/schema negative matrix: tests/unit/yaml.test.ts, manifest.test.ts |
| A16 | Build artifact installs and reproduces the full section-1 demo with recorded results | **PASS** | run started from a rebuilt VM |

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
