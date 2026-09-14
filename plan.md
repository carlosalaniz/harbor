# Harbor — autonomous implementation plan

**Date:** 2026-09-13  
**Requirements:** [TDD.md](TDD.md)  
**Assignment:** build the simple first release defined there, not a future infrastructure platform.

## 1. Instructions to the implementing agent

Read TDD.md fully, then execute this plan in order. These two documents are the only product input. Do not ask for an old repository, server configuration, prior chat, design spec, or hidden credentials. Public upstream documentation and ordinary dependency downloads are allowed for implementation research.

**Work autonomously, but not beyond authorized systems.** Write/build/test in the new workspace supplied for this task. Host bootstrap, Docker mutation, OS package changes, tool provisioning, and reboot tests require a positively identified disposable test VM or dedicated test machine. The documents' storage location is not that authorization.

Make small technical decisions using the prescribed stack and record them in generated documentation. Do not turn reasonable library/patch-version choices into product questions. Ask/stop only for an actual safety boundary, missing required environment/access, indispensable secret that must be entered outside chat, or irreconcilable required-app compatibility problem. While a live test is blocked, keep implementing/testing independent safe work.

Do not spend the first phase building auth platforms, registries, provider SDKs, or future schemas. One real app must run early. The minimal UI comes before the stateful app. A completed phase is working software plus evidence, not just a plan or scaffold.

### Scope lock

Deliver Excalidraw, BentoPDF, n8n/PostgreSQL; one Node daemon; SQLite; local API/CLI; minimal React UI; owned resources; readiness; durable serial jobs; retain-data removal/reinstall; bootstrap artifact; Cockpit/Portainer setup/binding/links; tests and operator documentation.

Do **not** build AFFiNE/Immich/ERPNext/Nextcloud (including AIO), OnlyOffice/Collabora integration, NPM/proxy automation, backups, app updates, external disks, TUF, worker RPC split, encryption/recovery kits, hooks/plugins, notifications, roles/MFA/SSO, public administration, adoption, purge, or cloud infrastructure. They are outside this assignment. Do not create empty directories/interfaces for them. Read TDD.md section 14 for future integration context, not additional implementation tasks.

Harbor remains the temporary name. Centralize naming and do not publish packages/domains or rename the product as a side task.

## 2. Working method and progress

1. Inspect the provided new workspace and applicable instructions; preserve existing user files. If it contains only these docs, initialize the project there.
2. Record environment facts: language/build tools, OS/architecture, whether a designated VM exists, and how it is reached. Do not inventory unrelated application data or secret files.
3. Keep a concise generated `PROGRESS.md` with phase/checklist, decisions, test results, blockers, and exact next step. This is output created during the build, not missing input.
4. For each feature: write a focused failing test, implement the smallest working behavior, run relevant tests, then integrate it into the real product path. No need for extensive property-testing frameworks.
5. Commit source/package locks and tests together if the workspace is a local Git repository and commits are authorized; never push/publish automatically. A clean working tree is not a substitute for passing tests.
6. At each checkpoint report what actually ran, what changed, and what remains. Persisted status/events must agree with visible CLI/UI behavior.
7. Do not stop after the first scaffold or two-app proof if required phases remain and tools permit continuing.

Use TDD.md as the authority for behavior. This plan determines order. If a necessary small correction is discovered, update both documents and the decision log coherently. Do not silently relax ownership/auth/retention constraints or expand the product scope.

## 3. Phase 0 — Establish a buildable skeleton, not a framework

### Work

- Pin Node 24 LTS patch and pnpm version. Set strict TypeScript ESM and a lockfile.
- Create one root package with a modest source tree: core/domain, state, Docker adapter, API, CLI, bootstrap, packages; add web and tools only when implemented.
- Add Fastify, Commander, Ajv, yaml, better-sqlite3 and Dockerode; install other listed dependencies when used. Pin tested versions via the lockfile, not arbitrary guessed versions.
- Configure Vitest, ESLint, typecheck and build. Add fake Docker/clock/ID dependencies at the I/O boundary, not a large dependency-injection framework.
- Write the first Excalidraw manifest/schema fixture from TDD.md and strict parser tests.
- Select a maintained upstream image release for Linux amd64, resolve its real digest, record artifact/image provenance. Perform image operations only on the authorized VM; read-only remote metadata research can happen in development.
- Implement `/healthz`, local settings and explicit fresh-state initialization, singleton lock, and the minimum local enrollment/session path needed for the CLI. Do not expose unprotected administrative routes during development as a shortcut.
- Generate the minimal disposable-VM `Vagrantfile` specified in section 9 (pinned Ubuntu 24.04 box, base OS only, loopback-only port forwards) as build output and document `vagrant up/ssh/halt/destroy/snapshot` plus the `pnpm test:vm` opt-in target.

### Tests first

- Valid minimal manifest accepted; duplicate key, alias, traversal, unknown field, invalid reference and unresolved digest rejected.
- Same render inputs produce equivalent normalized model; different instance IDs cannot generate same project/network name.
- Missing non-initialized state and corrupt state are errors, not triggers for silent reset.

### Exit

- Build, typecheck and unit tests pass.
- CLI can connect/authenticate to the local daemon and list the bundled package entry.
- Nothing pretends an app is installed yet. Do not call the product done.

## 4. Phase 1 — One real application end-to-end

### Work

- Implement the Excalidraw package loader and checksum inventory verification.
- Build the narrow source-Compose allowlist before running Compose canonical validation. Clear ambient Compose/Docker configuration and prohibit arbitrary file loading.
- Implement stable instance UUID/project/name allocation, loopback port search and conflict checks.
- Add immutable plan records and confirmation; basic one-use/idempotent operation submission with instance/name/port claims in a transaction.
- Implement the one-at-a-time daemon queue, intent/status/events, narrow Compose invocation, and recorded owned Docker IDs/labels.
- Render standard Compose under a private instance directory. Run the actual app, probe its verified binding, and expose installed status/Open URL only after readiness.
- Implement `catalog`, `plan`, `apply`, `install`, `list`, `inspect`, `operation` in the CLI. Secret input is hidden/stdin, never a valued command-line flag.
- Once the first real app works, automate that smoke path instead of rewriting the architecture.

### Tests first

- Expired plan and changed allocations do not apply.
- Duplicate same request returns the same operation; different request with same idempotency key conflicts.
- A deliberately occupied external port survives the failed allocation attempt unchanged.
- Readiness timeout reports failure and preserves an inspectable instance rather than claiming rollback.
- Client disconnect does not cancel queued/running work.

### Live checkpoint

On the designated VM, install Excalidraw through Harbor, open a drawing, and export it. Record actual image/Engine/Compose/runtime versions and the operation/resource identities. Mocks are not evidence for this checkpoint.

If live execution is unavailable, mark this checkpoint blocked and continue independent implementation. Do not test against the current machine merely because it has Docker.

## 5. Phase 2 — Two apps coexist, then the minimal UI

### Work

- Add the complete independent BentoPDF package and real digest. Make no app-name changes in the generic engine.
- Implement `start`, `stop`, `remove`, persisted desired state, resource ownership checks and retained records. Stateless remove still retains instance identity; no global/orphan/volume pruning.
- Persist and report observations; on daemon restart mark interrupted jobs needs-action without blind replay. Ensure child Compose processes cannot continue unnoticed during a tested service restart.
- Create the minimal React UI: login, Installed, Available, System, Platform tools sections, short install/confirmation, progress, Open, Start/Stop, Remove.
- Use the bearer session model in TDD.md: memory-only browser token, re-login on reload, then fetch existing operation state. No cookies/storage token workaround and no automatic resubmission.
- Add plain CSS for a clean responsive dashboard, semantic elements, keyboard focus, loading/error/empty states. No rich charts, theme engine or new UI framework.
- Generate/document the implemented small OpenAPI surface, keeping it aligned with route validators and DTOs.

### Tests first

- BentoPDF installs while Excalidraw stays healthy; compare A's container IDs/creation times before and after B's installation.
- Second Excalidraw uses distinct instance/project/network/port.
- Stop/remove B leaves A and a test-owned unrelated sentinel unchanged.
- Fresh page/re-login finds the accepted job/instance; duplicate button clicks do not create duplicates.
- Unauthenticated or wrong-origin/Host/content-type administration fails; no credentials in DTOs or browser persistent storage.

### Live checkpoint

CLI and UI both install/list/open Excalidraw and BentoPDF. Perform a representative browser PDF operation, not just an HTTP GET. UI action results match CLI state. Reboot checks can be completed after bootstrap is in place in Phase 5; prepare their assertions now.

**Do not postpone this UI until database backup, application updates, or external storage exists.**

## 6. Phase 3 — Stateful package through the same engine

### Work

- Select and pin supported n8n and PostgreSQL versions/digests. Verify persistence layout, readiness URL and task-runner requirements against upstream docs and the selected release.
- Implement only generic declared local-volume allocation, ownership tokens, persisted secret references, generated-secret bindings, and endpoint URL environment bindings.
- Materialize n8n's manifest/Compose/inventory/README from TDD.md. Compose defines its private database dependency; do not write a custom n8n/Postgres orchestration function.
- Create owned volumes explicitly, then reference them as external in generated Compose. Source packages still cannot reference arbitrary external volumes.
- Generate keys once with exclusive durable writes, keep all runtime material private, reuse identities on normal operations.
- Add explicit `reinstall` for a previously successful retained instance using its exact stored release and matching persistence. Missing data/keys or partial never-installed data must block, not initialize replacements.
- Show separate user-onboarding guidance. The API must not claim account setup just because n8n responds to readiness.

### Tests first

- Multiple bindings for one secret receive the same value; two instances receive different values.
- No secret in plan summary, DTOs, logs, error strings, source artifacts or browser persistent state.
- Volume disappearance/replacement with another token blocks start/reinstall before Compose creation.
- Secret disappearance blocks rather than regenerates.
- Stop/start and remove/reinstall preserve exact keys and database identity.
- Literal environment values and URLs render correctly; package interpolation/injection payloads rejected.

### Live checkpoint

Create n8n's owner in the browser using synthetic test credentials. Create a simple workflow and a credential against a local test HTTP endpoint. Demonstrate a successful credentialed execution before and after remove/reinstall. Verify a second n8n instance has distinct data/keys and that Excalidraw remains usable. Never use real personal accounts or production credentials for this test.

If the selected upstream release needs another runner container, add a normal package service and the smallest reusable schema extension with tests; do not silently disable security or declare advanced runner support without evidence. A workflow not using Code nodes is enough for the mandatory demo.

## 7. Phase 4 — Bootstrap and real platform-tool links

### Work

- Package compiled daemon/CLI/bootstrap, React assets, runtime, production/native dependencies and qualified catalog into the release archive.
- Use a tiny launcher only to find bundled Node; keep bootstrap logic in TypeScript. No npm install/root builds on the application host.
- Implement idempotent bootstrap with explicit host/prequisite approval and a clear conflicting-installation error. Authenticate package repositories; do not modify an existing Docker setup without review.
- Install/test the service account, ownership, singleton lock, systemd unit, local listener and local administrator enrollment/reset. Restarting Harbor must not stop independent app containers.
- Offer `--with-tools` and implement the approved Cockpit OS-service and Portainer platform-recipe setup described in TDD.md.
- Record actual tool addresses/ownership/status, then render real Open links. Use separate tool login/enrollment; no shared passwords or secret-bearing URLs.
- Support explicit binding to already installed tools without taking ownership. A missing tool is a visible state, not a hardcoded healthy card.
- Write local/SSH access instructions. Same-port local forwarding must cover the management endpoint, installed app ports and tools. Keep privileged tool listeners private for new installations.

### Tests first

- Repeated bootstrap preserves state/admin/key/application identities.
- Conflicting paths/service/ports do not overwrite an unrelated installation.
- Rootless/unapproved prerequisite mutation reports the required action rather than repeatedly elevating.
- Normal app removal cannot target platform resources.
- Tool absent/unreachable/setup-required/TLS-trust-needed states render accurately.

### Live checkpoint

Fresh VM without Node/npm: install the archive, enroll/login, approve tools, complete their native onboarding, and open both from Harbor. Test an explicit existing-tool binding separately. A failed tool setup may leave ordinary apps functional, but does not pass the real-link acceptance test.

## 8. Phase 5 — Reproduce the full demo and finish

### Work

- Implement the external VM smoke-test controller or a small reproducible host/guest test pair. It must target only the explicitly authorized test VM and use bounded reconnect waits.
- Run A01–A16 from TDD.md. Keep the same tests available for a new engineer, not only manual narration.
- Run actual daemon restart, full VM reboot, stopped-instance reboot, and n8n retention tests.
- Create a limited test-owned unrelated sentinel service/occupied port to verify non-interference; clean up only fixture-owned resources. Never use global prune.
- Confirm invalid packages have zero effects, interrupted operations show honest state, and Docker unavailable does not yield a false healthy display.
- Resolve failures, rerun relevant tests and then the complete smoke path. Do not replace failing required tests with skipped mocks.
- Produce README and operator guide with build/install/login/SSH access/app lifecycle/tool setup/troubleshooting instructions, explicit preview limitations and data-retention behavior.
- Add a short future-context note summarizing TDD.md section 14: Nextcloud with OnlyOffice/Collabora may later use a dedicated bundled service, a selected shared provider, or an AIO-controlled deployment. Explain the remaining routing/connector/save-callback work, without claiming it is supported or implementing it.
- Produce verification report with actual commands, environment/versions, test counts and outcomes, demo evidence, and any blockers. Do not include real secrets or application payloads.

### Completion checklist

- [ ] Frozen-lockfile dependency install and clean build succeed in a fresh development checkout.
- [ ] Lint, typecheck, unit, integration and browser tests pass.
- [ ] Real app package digests and inventories are complete; no editorial placeholders/floating tags.
- [ ] Two unrelated apps plus repeated instances coexist through one generic path.
- [ ] Minimal Web UI exists and uses the same API as CLI.
- [ ] n8n retains a usable workflow and credential across exact-release reinstall.
- [ ] Cockpit and Portainer Open links work on the fresh approved bootstrap profile.
- [ ] Daemon/host restart and completed-stop persistence pass on the designated VM.
- [ ] No foreign workloads or persistent data are removed by a Harbor operation/test cleanup.
- [ ] Authentication and secret-output negative tests pass.
- [ ] Bootstrap archive works without destination Node/npm and does not overwrite existing state.
- [ ] A01–A16 each has actual evidence; blocked/manual items are labeled accurately.
- [ ] Repository is self-contained with source, lockfile, packages, tests, release builder, guides and verification report.
- [ ] Excluded roadmap features have not been implemented accidentally.
- [ ] Future integration context is documented without hardcoded one-service/one-endpoint assumptions or speculative provider infrastructure; no Nextcloud/office functionality is claimed.

Then stop and report the scoped release delivered, tests actually run, artifact location and limitations. Do not proceed automatically to advanced apps, registry infrastructure, backups or public deployment.

## 9. Environment, testing, and safety details

### Default development mode

- Pure/unit tests need no root or Docker. Use fake I/O adapters and temporary private state directories.
- Build/test commands never discover/use a Docker socket by accident. Live integration requires an explicit opt-in and target identity; refuse a generic unspecified “current Docker host.”
- Do not read env files, application databases or keys from outside the new repository/test fixtures.
- Permission changes are confined to Harbor-owned build/state material. No arbitrary recursive chown of host storage.
- The two handoff docs can be copied to an empty repository. Creating source/tests/runbooks afterward is expected; no other initial input files are needed.

### Required script behavior

| Script | Expected behavior |
|---|---|
| `pnpm dev` | Local development with fake adapter/private state by default; explicit mode for designated live target |
| `pnpm build` | TypeScript and Web UI production build |
| `pnpm lint` / `pnpm typecheck` | Fail on violations; no ignored blanket errors |
| `pnpm test` | Fast unit/contract tests, no host mutations |
| `pnpm test:integration` | Temporary state/API/adapter tests; live Docker only with required target opt-in |
| `pnpm test:e2e` | UI tests with explicit fixture profile; distinguish mocked UI from real app demo evidence |
| `pnpm test:vm` | Full authorized live smoke/reboot tests against the Vagrant VM only; missing VM fails with a prerequisite message, not silent skip |
| `pnpm package` | Reproducible release archive and checksums for the qualified host/runtime |

### Vagrant test VM (generated output, not input)

Generate a minimal `Vagrantfile` during Phase 0 as build output: one disposable `harbor-test` VM from a pinned Ubuntu 24.04 x86-64 box version, 2 CPUs / 4 GiB RAM minimum, base OS only (no preinstalled Node/npm/Docker), default synced folder for repository access only, Harbor state kept inside the VM, and only the management port plus the few demo app ports actually used forwarded to host loopback with `host_ip: "127.0.0.1"`. Use `vagrant up / ssh / halt / destroy -f / snapshot` for clean, reboot, and reset; `pnpm test:vm` targets only this VM via explicit opt-in. If virtualization is unavailable on the build host, label live evidence BLOCKED with reproduction steps and continue independent safe work.

A non-Ubuntu development machine can run safe unit/build/UI work, but is not evidence of Ubuntu/systemd lifecycle behavior. Do not require the user to provide production secrets to achieve test coverage.

### Legitimate blockers

Record a blocker only when it cannot be resolved safely from these documents and public technical references: no authorized test VM, no required privileges, unreachable upstream artifact/repository, incompatible maintained required-app release, or unavailable browser/test capability.

Include what is blocked, why, exact prerequisite, what is already implemented/tested, and a reproducible command/procedure for the later environment. Continue independent safe work. Do not claim end-to-end completion while A01/A03/A09/A11/A14/A16 are unverified.

## 10. Decision defaults: do not overthink these

- Single process, serial jobs, polling, SQLite, plain modules, minimal CSS.
- One local administrator, opaque bearer sessions, loopback only, explicit forwarding.
- Three bundled packages; no remote store server or signature infrastructure.
- Exact image digests and runtime validation, not a large supply-chain platform.
- Named local volumes and retained secret files, not storage pools or an encrypted vault.
- Safe failure/needs-action, not generic transaction rollback or effect replay.
- Standard platform tools exposed through real links, not embedded consoles.
- Small JSON Schema extended only for required package behavior, not every future Compose feature.
- Working demonstrations and tests before abstraction cleanup.

**The autonomous task is finished when the simple product works and its required acceptance evidence exists—not when a large future platform has been scaffolded.**

## 11. Context-only architecture check

Before final handoff, read TDD.md section 14 and review the existing implementation—not a new subsystem—for these points:

- Services/volumes/endpoints are package data, keyed by identity, rather than a single global “web container.”
- Browser URLs are distinct from internal targets; adding a future proxy would change access/rendering logic rather than every app package.
- Instance-owned resource removal and instance-scoped secrets do not assume product names are unique.
- The UI distinguishes runtime/readiness from setup and does not equate an office landing page with a working document save integration.

If an inexpensive existing-code correction is needed, make and test it. Otherwise only document the extension points and stop. **Do not add Nextcloud or an office server to the catalog, install proxy infrastructure, invent provider APIs, change the current strict schema, or create another build phase for this future use case.** This check does not change the three-app scope or require any new live infrastructure tests.
