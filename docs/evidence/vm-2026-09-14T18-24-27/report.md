# Live VM run vm-2026-09-14T18-24-27

- Target: digitalocean droplet 600403086 (143.198.73.104) ({"kind":"digitalocean","dropletId":600403086,"size":"s-4vcpu-8gb","image":"ubuntu-24-04-x64","region":"sfo3"})
- Archive: harbor-0.1.0-linux-x64.tar.gz
- Fresh VM: true · reboot test: true
- Versions: {"ubuntu":"Ubuntu 24.04.4 LTS","arch":"x86_64","systemd":"systemd 255 (255.4-1ubuntu8.16)","docker":"29.8.0","compose":"5.5.1","node":"v24.12.0","harbor":"0.1.0"}
- Started 2026-09-14T18:24:27.307Z, finished 2026-09-14T18:38:17.645Z

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
| A12 | Remove/reinstall the exact n8n instance preserves workflow and credential; missing volume blocks without replacement | **FAIL** | harbor reinstall d7a51d39-f8fa-452a-8089-86ed84f98ef5 --yes exited 3:  instanceId": "d7a51d39-f8fa-452a-8089-86ed84f98ef5",
  "planId": "87de1ddb-287e-454f-bb5b-724844cd895a",
  "state": "needs_action",
  "phase": "needs_action",
  "createdAt": "2026-09-14T18:34:44Z",
  "startedAt": "2026-09-14T18:34:44Z",
  "finishedAt": "2026-09-14T18:34:44Z",
  "error": {
    "code": "DATA_MISSING",
    "message": "retained volume hb_d7a51d39f8fa452a808986ed84f98ef5_database no longer exists",
    "nextAction": "The data volume is gone. Restore it from your own backup or remove the instance; Harbor will not create an empty replacement."
  },
  "result": null,
  "events": [
    {
      "cursor": "134",
      "at": "2026-09-14T18:34:44Z",
      "phase": "queued",
      "message": "reinstall accepted for instance n8n-2"
    },
    {
      "cursor": "135",
      "at": "2026-09-14T18:34:44Z",
      "phase": "preparing",
      "message": "loading stored release and verifying retained data"
    },
    {
      "cursor": "136",
      "at": "2026-09-14T18:34:44Z",
      "phase": "needs_action",
      "message": "reinstall needs_action: retained volume hb_d7a51d39f8fa452a808986ed84f98ef5_database no longer exists"
    }
  ]
}
{
  "error": {
    "code": "DATA_MISSING",
    "message": "retained volume hb_d7a51d39f8fa452a808986ed84f98ef5_database no longer exists",
    "nextAction": "The data volume is gone. Restore it from your own backup or remove the instance; Harbor will not create an empty replacement.",
    "operationId": "d18ab362-1391-41c4-9123-8879c047c549"
  }
}
 |
| A10 | Failed/interrupted install shows needs_action, retains scope, no blind replay; Docker unavailable is not healthy | **PASS** | install completed (failed) before the restart took effect; interruption semantics are covered by tests/integration/lifecycle.test.ts<br>Docker stopped -> Harbor stayed active, system docker.available=false, instances unavailable/unknown (none healthy), plan -> 503 DOCKER_UNAVAILABLE; Docker started -> healthy again |
| A13 | UI login/logout, bearer auth, Host/Origin/content type controls; no secrets in DTOs or browser storage | **PASS** | 401/403/422/400 controls verified over the tunnel<br>no secret values or bearer tokens in DTOs or journal<br>browser: no localStorage/sessionStorage/cookies; logout revokes the token<br>login rate limiting (429) is covered by tests/integration/auth.test.ts to avoid locking this run out |
| A14 | Cockpit and Portainer bootstrapped with approval; onboarding works; real Open links; absent/external tools honest | **FAIL** | locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /Create user/i })
    - locator resolved to <button type="submit" disabled="disabled" ng-click="createAdminUser()" button-spinner="state.actionInProgress" class="btn btn-primary btn-sm ng-isolate-scope" ng-disabled="state.actionInProgress \|\| form.$invalid \|\| !formValues.Password \|\| !formValues.ConfirmPassword \|\| form.password.$viewValue !== formValues.ConfirmPassword \|\| (requiresSetupToken && !formValues.SetupToken)">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    58 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms
 |
| A09 | Daemon restart leaves apps running; host reboot returns desired-running apps; intentional stop stays stopped | **PASS** | daemon restart: container ids/creation unchanged; UI recovered after login<br>host reboot (2026-09-14 18:24:51 -> 2026-09-14 18:37:17): desired-running apps healthy again, excalidraw-2 stayed stopped |
| A15 | Package traversal/aliases/duplicate keys/interpolation/undeclared mounts/privileges rejected; malformed API bodies never execute | **PASS** | malformed/oversized/invalid API bodies -> 4xx with zero Docker effects<br>package with privileged/alias/interpolation/bind mount -> unavailable in catalog, plan rejected<br>full parser/schema negative matrix: tests/unit/yaml.test.ts, manifest.test.ts |
| A16 | Build artifact installs and reproduces the full section-1 demo with recorded results | **FAIL** | run started from a rebuilt VM<br>failed: A12, A14 |

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
