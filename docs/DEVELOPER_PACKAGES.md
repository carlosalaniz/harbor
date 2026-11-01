# Build your own app for Harbor

Harbor installs *packages*: a zip with a manifest, a Compose file and a few optional files. Anyone can
build one and upload it from the console (**App Store → + Your own app**) or the CLI
(`harbor packages add my-app.zip`). Harbor checks the package the same way it checks the built-in
catalog, pins the images by digest for you, and puts it in *your* App Store. Upload a higher
`release.revision` later and Harbor offers an **Update** to every app installed from it.

Developing in a repository? Point Harbor at it instead (**App Store → + Your own app → Git
repository**, or `harbor sources add https://github.com/you/your-app`): Harbor fetches the branch,
imports the `harbor/` folder below, and every new commit becomes an update — deployed automatically
if you turn on *redeploy on commit*. See §7.

## 1. The zip

```
my-app/
  manifest.yaml     required
  compose.yaml      required
  README.md         optional (Harbor writes a short one if missing)
  icon.svg          optional, named in manifest presentation.icon (svg/png, ≤ 256 KiB)
  shot-1.png        optional screenshots, named in presentation.gallery (≤ 1 MiB each)
```

`zip -r my-app.zip my-app/` is fine (the top folder is stripped). Limits: 50 MB zip, 256 files.

## 2. manifest.yaml (template)

```yaml
apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: my-app                     # lowercase letters, digits, dashes; must not collide with a built-in app
  name: My App
  description: One sentence about what it does
release:
  revision: "1"                  # raise it (2, 3, …) for every new upload; this is what triggers updates
  version: "1.0.0"               # the app's own version, shown to people
  # minHarbor: "0.28.2"          # optional: the oldest Harbor release this revision runs on (§10)
deployment:
  compose: compose.yaml
  multiInstance: true            # false if only one copy may run (the Store then shows Open, never a second Install)
  services:
    web: application             # every compose service, marked application or infrastructure
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary     # secure if the app is better on HTTPS (clipboard, camera, PWA)
    httpsRequired: false         # true only if it does NOT work over plain http at all (secure-only login
                                 # cookie, WebCrypto vault): in LAN mode it then needs an HTTPS main address
                                 # (secure LAN, Tailscale or a domain) and the store says so before install
    kind: web                    # web (default) | api: machine-facing (an MCP gateway, a document server):
                                 # addresses to copy, no Open button (decision 141). Put it on ui.primaryEndpoint.
    # cookies: shared            # optional (Harbor 0.32.0, decision 167): writing the key at all needs
                                 # release.minHarbor: "0.32.0" (older Harbors refuse unknown keys).
                                 # isolated (default) = over the secure LAN address Harbor's relay renames and
                                 # signs this endpoint's HttpOnly cookies, so other apps on the same machine never
                                 # receive them. shared = its own cookies pass unchanged (it still never receives
                                 # another app's isolated cookies, and may not set a name shaped like one). Only for an app that must hand its cookie to
                                 # something else on harbor.local; most apps never need it.
ports:                           # optional (Harbor 0.29.0, decision 163; set release.minHarbor: "0.29.0"):
  wireguard:                     # a fixed host port published on EVERY network of the machine, no proxy, no URL
    service: app                 # e.g. a VPN server's tunnel port. Needs multiInstance: false. The plan refuses
    containerPort: 51820         # a port another app holds, something on the machine uses, or one inside
    hostPort: 51820              # Harbor's own range. The console says which port to forward on the router.
    protocol: udp                # udp only for now
    purpose: WireGuard VPN tunnels   # A release that ADDS a port is accepted like a new permission (0.31.0).
permissions:                     # optional (0.29.0, decision 163): per service, from this fixed list only.
  app: [net-admin, ip-forwarding]  # net-admin = NET_ADMIN (tunnels, routes, firewall rules); tun = the
                                 # /dev/net/tun device (OpenVPN); ip-forwarding = net.ipv4.ip_forward and friends,
                                 # inside the app's own network. Harbor renders them; cap_add/devices/sysctls stay
                                 # refused in compose.yaml. The operator accepts them when approving the install
                                 # (and an update that adds one); update-all and auto-update skip such updates.
                                 # gpu (0.34.0, decision 179; set release.minHarbor: "0.34.0") = this machine's
                                 # graphics card, e.g. `ollama: [gpu]`: see "The gpu permission" below.
                                 # privileged + binder (0.40.0, decision 193; set release.minHarbor: "0.40.0") =
                                 # full control of this machine / Android's binder driver: OFFICIAL CATALOG ONLY,
                                 # see "Trusted-only permissions" below.
health:
  endpoint: web
  path: /                        # must answer before any account exists; a published address of this
                                 # endpoint is checked at this path too (API-only app: e.g. /healthz)
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 90
ui:
  primaryEndpoint: web
storage:                         # optional: one claim per named volume
  - id: data
    composeVolume: data
    purpose: Uploaded files
    retention: retain
    external: {hint: "Pick a folder with room, e.g. /srv/harbor/MyApp", required: false, readOnly: false}
    # Claiming a folder stamps an app-generated drive id into its `.harbor-bind.json` marker
    # (random at install, kept on restore, fresh on replacement). A missing, foreign or
    # swapped folder refuses Start with DATA_MISSING; the observer stops the app when its
    # drive leaves and auto-starts it when the right folder is back (see decisions 89–90).
secrets:                         # optional: Harbor generates and keeps these
  - id: app-secret
    bytes: 32
    encoding: hex
    retention: retain
    # showOnce: JWT secret for the document server   # optional (decision 138): the operator sees this
    #                              generated value once after install, under this label (e.g. to paste it
    #                              into another system); never shown again, kept as an instance secret
    bindings:
      - service: web
        environment: APP_SECRET
      - service: web             # the value inside a literal (decision 139): images without a shell
        environment: DATABASE_URL  # cannot assemble a URL in `command:`. Exactly one {{value}}; no `$`.
        template: "postgres://app:{{value}}@db:5432/app"
        encode: url              # optional: percent-encode the value first (operator-typed passwords)
  - id: upstream-token           # …or asks the operator for one at install (decision 125, see §8)
    source: operator
    prompt: Access token of the documents app (its Settings → Access tokens)
    minLength: 16                # optional limits (1–4096); one line, no control characters
    optional: false              # true: install may leave it empty (the variable is then not set)
    retention: retain
    bindings:
      - service: web
        environment: UPSTREAM_TOKEN
links:                           # optional: talk privately to another installed app (decision 126, see §8)
  - id: docs                     # lowercase, ≤ 30 chars; the other app answers as `docs-link`
    purpose: The documents app this gateway reads and writes
    provider:
      packages: [docsapp]        # optional: which packages can satisfy it (any app when omitted)
      endpoint: web              # optional: the provider's endpoint (default: its main one)
    optional: false              # true: install may go without a provider for now
    bindings:
      - service: web             # only bound services join the link network
        environment: DOCS_BASE_URL
        format: url              # url (http://docs-link:3010) | authority (docs-link:3010) | host | port
settings:                        # optional (0.34.0, decision 180; set release.minHarbor: "0.34.0"): values the
                                 # operator can change, see "Settings the operator can change" (§8). Not secrets.
  - id: context-length           # lowercase, dashes, ≤ 40 chars; the CLI's --set context-length=16384
    label: Context length (tokens)
    help: How much text a model keeps in mind. More uses more memory.   # optional, ≤ 300 chars
    type: integer                # integer | number | boolean | string | choice
    default: 8192                # required, must fit the rules below
    min: 2048                    # optional (integer/number only)
    max: 131072
    bindings:                    # 1–8 variables; each is this setting's alone (not in compose.yaml)
      - service: web
        environment: OLLAMA_CONTEXT_LENGTH
  - id: flash-attention
    label: Flash attention
    type: boolean
    default: false
    onValue: "1"                 # optional (boolean only): what the variable gets (default "true"/"false")
    offValue: "0"
    bindings:
      - {service: web, environment: OLLAMA_FLASH_ATTENTION}
  - id: kv-cache
    label: Memory cache precision
    type: choice
    default: f16
    choices: [{value: f16, label: Full}, {value: q8_0, label: Half}, {value: q4_0}]   # 1–32; label optional
    bindings:
      - {service: web, environment: OLLAMA_KV_CACHE_TYPE}
  - id: keep-alive
    label: Keep models loaded
    type: string                 # one line, no control characters
    default: 5m
    maxLength: 16                # optional (string only, 1–1024, default 256)
    bindings:
      - {service: web, environment: OLLAMA_KEEP_ALIVE, template: "{{value}}"}   # optional template, one {{value}}, no `$`
network:                         # optional, Harbor ≥ 0.36.0 (declare release.minHarbor: "0.36.0")
  internet: offline              # direct (default) | vpn | offline: what the app starts with; the operator may
                                 # choose another (decision 185). offline = opens no connection at all; vpn =
                                 # only through Harbor's VPN (no internet while it is down)
configuration:                   # optional: hand the app its main address (links it sends out)
  - service: web
    environment: PUBLIC_URL
    endpoint: web
    format: origin               # url | origin | authority | host | scheme
                                 # The main address is the one picked at install: this network (secure
                                 # LAN when on, else LAN, else localhost), Tailscale or a domain. Written
                                 # at install/update/Restart — not at a plain Start.
hooks:                           # optional: apps that check the Host they are reached by (Nextcloud)
  afterStart:                    # runs INSIDE `service` after every start, Restart, publish and unpublish
    service: web
    user: www-data               # optional; the image's default user otherwise
    timeoutSeconds: 120          # 10–1800; a failing or slow hook is reported, the app still runs
    command: [sh, -c, 'for a in $HARBOR_ADDRESSES; do my-admin-tool trust "$a"; done']
                                 # Environment: HARBOR_ADDRESSES (every host[:port] it answers on, space
                                 # separated: localhost, LAN names/IPs on the http and secure ports, tailnet,
                                 # domains), HARBOR_PROXIES (where Harbor's proxies connect from — trust
                                 # forwarded headers only from these), HARBOR_URL (the main address).
                                 # Must be idempotent: it runs again on every address change.
setup:                           # optional: tell people what to do on first open
  endpoint: web
  instructions: Create the first account; it becomes the administrator.
defaultCredentials:              # optional: ONLY if the image ships a fixed login; shown with a "change it" warning
  username: admin
  password: changeme
  note: Change it under Settings → Users right after signing in.
provisionedCredentials:          # optional: Harbor creates the admin account through env vars at first install
  service: web                   # the service that reads them
  passwordEnv: ADMIN_PASSWORD    # Harbor injects a generated password here
  usernameEnv: ADMIN_USER        # either: Harbor injects the username ("admin" or `username`) here…
  username: admin                # …or the image uses a fixed name (then omit usernameEnv)
  note: Shown next to the one-time credentials after the install.
  label: My App admin login      # optional: what the one-time display calls it (default "<name> admin login")
                                 # Mutually exclusive with defaultCredentials. The credential is shown
                                 # once in the install result and retained as an instance secret.
presentation:
  tagline: Short line shown on the card
  category: productivity         # productivity media files automation network developer ai security finance home other
  icon: icon.svg
  gallery: [shot-1.png, shot-2.png]   # up to 6 screenshots (png/jpg/webp ≤ 1 MiB); a strip on the install page
  developer: You
  website: https://example.com
  source: https://github.com/you/my-app   # Harbor ≥ 0.30.0 (declare release.minHarbor: "0.30.0"): "Source code on GitHub" on the install page
  releaseNotes: What changed in this revision (shown before an update)
  sizeHint: About 300 MB, plus your files   # optional, ≤ 120 chars: shown as "Needs …" on the install page
  hideFromHome: false            # true suggests hiding it from Home (helpers without a page); the operator decides
```

Text the operator reads (names, descriptions, prompts, setup instructions, notes) is plain text: it is
shown as text everywhere, never as HTML, so `Bearer <token>` and `https://<domain>/` are fine
(decision 137). Control characters are refused.

## 3. compose.yaml (the supported subset)

```yaml
services:
  web:
    image: nginx:1.27-alpine          # a tag is fine: Harbor resolves it to repository@sha256 at upload
    environment:
      TZ: UTC
    volumes:
      - type: volume
        source: data
        target: /usr/share/nginx/html
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1/"]
      interval: 10s
      timeout: 5s
      retries: 5
volumes:
  data: {}
```

Allowed per service: `image`, `command` (an argument array, decision 123), `environment` (literal
values), `depends_on` (with `condition`), `healthcheck`, `volumes` of `type: volume`. Not allowed, on
purpose: `ports` (Harbor publishes the endpoints on 127.0.0.1 itself), `entrypoint`, `privileged`, `cap_add`, `devices`, `deploy`, `runtime`, `group_add`, host networking, bind mounts
(operators choose folders through storage claims instead).

**The gpu permission** (Harbor 0.34.0, decision 179; set `release.minHarbor: "0.34.0"`). `permissions: {<service>: [gpu]}`
asks for the machine's graphics card. Harbor writes what Docker needs from what it finds when it prepares the
containers, never from the package:

| The machine has | Harbor renders for that service |
|---|---|
| NVIDIA card + NVIDIA container toolkit (Docker restarted since) | `deploy.resources.reservations.devices: [{driver: nvidia, count: all, capabilities: [gpu, compute, utility]}]` (Docker then sets `NVIDIA_DRIVER_CAPABILITIES=compute,utility`) |
| Intel/AMD graphics (an i915, xe, amdgpu or radeon render node) | that node only, `devices: ['/dev/dri/renderD128:/dev/dri/renderD128']`, + `group_add` (the node's group; no `card<N>`, no `video`) |
| nothing usable (or NVIDIA without the toolkit, or Docker not restarted since) | nothing: the app runs on the CPU |

So the image must work on the CPU too (Ollama does), and must not set its own NVIDIA selection variables: on a
service granted `gpu`, `NVIDIA_VISIBLE_DEVICES`, `NVIDIA_DRIVER_CAPABILITIES`, `NVIDIA_MIG_CONFIG_DEVICES`,
`NVIDIA_MIG_MONITOR_DEVICES` and `NVIDIA_IMEX_CHANNELS` are refused as `compose.yaml` literals and as secret, link,
setting or configuration targets (other `NVIDIA_*` variables, such as `NVIDIA_DISABLE_REQUIRE`, are fine). The
device request already selects the cards and the driver features (compute and utility: CUDA and `nvidia-smi`; no
graphics, display or video encoding yet). An image that uses integrated Intel/AMD graphics through Vulkan may need
its own switch for it (Ollama: `OLLAMA_IGPU_ENABLE: "1"`). `devices`, `deploy`, `runtime`, `group_add`, `gpus` and `device_cgroup_rules`
stay refused in `compose.yaml`. The operator accepts `gpu` like the other permissions, also on a machine without a
card. AMD ROCm (`/dev/kfd` + a `:rocm` image) is not supported yet.

**Trusted-only permissions** (Harbor 0.40.0, decision 193; set `release.minHarbor: "0.40.0"`). Two permissions are
granted only to apps from the official catalog (carlosalaniz/harbor-apps, signed); an uploaded zip or a git source
that asks for one is refused (`UNTRUSTED_SOURCE`) unless the operator turned on developer mode (Settings → Advanced
access, `harbor developer-mode on`), which shows a banner on every page while it is on. Test such a package that way,
then propose it to harbor-apps.

| Permission | Harbor renders | Use it for |
|---|---|---|
| `privileged` | `privileged: true` on that service: every device and capability, no seccomp or AppArmor. The review says *Full control of this machine*. | software that cannot run otherwise (redroid). Never as a shortcut for a device or capability the other permissions cover. |
| `binder` | nothing in Compose. Before any container of the app starts, Harbor's root step loads `binder_linux` (`devices=binder,hwbinder,vndbinder`) and keeps it loaded at every boot. A kernel without the module refuses the plan with `KERNEL_MODULE_MISSING` and the apt line (Ubuntu: `linux-modules-extra-$(uname -r)`). | Android containers (redroid; they mount binderfs themselves, so they also need `privileged`). |

`privileged` stays refused as a `compose.yaml` key: only the permission renders it, and the operator accepts it in
the review like every other permission (an update that adds it waits for a person).

`healthcheck: {disable: true}` (Harbor 0.28.4, decision 162; set `release.minHarbor: "0.28.4"`) switches off a check the
image carries. Use it when the image's own check cannot pass in your setup or takes longer than Harbor waits: Harbor
starts apps with `compose up --wait`, so an unhealthy container fails the install. `disable` stands alone (no `test`
or timings), and no service may wait for a disabled one with `condition: service_healthy`. Harbor's own HTTP health
check (`health:` in the manifest) still decides whether the app is ready.

`command` replaces the image's CMD (the image's ENTRYPOINT still runs first). Use the array form —
`command: [bench, worker, --queue, short]` — or a shell when you need one:
`command: [sh, -c, 'exec my-server --port 8080']`. Write it exactly as the container should receive it:
`$` is literal (Harbor escapes it for Compose), so `$HOME` reaches the shell, not Compose. The string
form (`command: my-server --port 8080`) is refused.

Every named volume needs exactly one storage
claim; every claim must be mounted. Secrets and configuration bindings must not be set literally in
`environment` as well.

**A cache should not persist** (lesson from a real move). A cache service such as Redis whose image
declares a `VOLUME` keeps its data in an anonymous volume across restarts and reboots. After a data copy
the app then ran with the empty install's cache (Frappe hid every Server Script until `bench clear-cache`).
Turn persistence off for caches — `command: [redis-server, --save, "", --appendonly, "no"]` — and claim
storage only for what is real data.

## 4. What Harbor does at upload

1. Reads the zip (no symlinks, no `..`, CRC checked). A manifest whose `release.minHarbor` is newer than
   this Harbor is refused first, with "needs Harbor x.y.z or newer". Then it validates `manifest.yaml` against the schema and
   `compose.yaml` against the subset, and cross-checks them (services, endpoints, volumes, bindings).
2. Resolves every image that is not already `repository@sha256:…` at its registry (anonymous pull token,
   `linux/amd64`), rewrites `compose.yaml` to the digest, and records tag, digests and image creation
   time in a generated `release.json` (qualification `pending`: Harbor did not test your app itself).
3. Stores the package under `/var/lib/harbor/packages/<id>/` and lists it in your App Store with a
   *Your app* badge. Installing it is the same one-click flow as a built-in app.
4. If a package with the same id exists: the new revision must be higher (same revision with the same files
   is a no-op; same revision with different files is refused). Apps installed from the older revision
   show **Update available**.

## 5. Updates

**Update** (app drawer, the Home *updates* card, or `harbor update <name>`) keeps the instance name,
ports, published addresses, data volumes, your folders and secrets. It stops and deletes the current
containers, stores the new release, creates volumes/secrets/ports the new release adds (volumes the new
release dropped are kept, never deleted), pulls the new images by digest, starts, and checks health.
If the new release does not start or answer, Harbor puts the previous release back and starts it again;
the operation fails with a clear message and the app keeps running as before. Data migrations are the
app's own business: Harbor never touches the contents of a volume.

**The version people see** (decision 174): the Store, the app page and update prompts show `release.version`
when the manifest has it, word for word. Without it, Harbor shows the version `release.json` records for the image of
the service behind `ui.primaryEndpoint` (`images.<svc>.appVersion`, which `catalog-pin.mjs` writes from the tag: `v1.2.3`
→ `1.2.3`), with an image variant dropped (`34.0.4-apache` → 34.0.4). So most packages need no `release.version` at
all; write one when the main image's tag is not the version people know (a `latest`-only image, an umbrella version
for several images). The revision stays what makes an update: the version is only shown.

The same mechanism updates built-in apps: a new official catalog (§10) carries a higher revision, and
every installed app from that package shows an update (or updates itself, where the operator turned on
automatic updates). This no longer waits for a Harbor release.

## 6. Handy commands

```sh
harbor packages                       # your uploaded packages
harbor packages validate ./my-app     # the daemon's validators on a folder (or a repo with harbor/), offline
harbor packages add my-app.zip        # upload (pins images, reports what changed)
harbor install my-app                 # install like any other package
harbor list                           # UPDATE column shows "-> 2 (1.1.0)" when one is available
harbor update my-app --yes            # update; rolls back automatically on failure
harbor packages remove my-app         # only after every app from it is uninstalled completely
```

## 7. Apps from a git repository (develop → push → redeploy)

A repository layout Harbor understands:

```
your-app/
  harbor/
    manifest.yaml     required (same template as §2)
    compose.yaml      required (same subset as §3, plus `build:` below)
    README.md         optional
    icon.svg          optional
  app/
    Dockerfile        your code, built on the machine at install/update time
    …                 whatever the Dockerfile needs
```

`compose.yaml` services may declare `build:` **instead of** `image:` (git sources only; zip uploads
refuse it):

```yaml
services:
  web:
    build:
      context: ../app        # relative to harbor/; may step up into the repo, never out of it
      dockerfile: Dockerfile # optional, defaults to Dockerfile
```

The context and its Dockerfile must be real folders and files inside the repository (checked on disk, not
only by name: a symbolic link that leads out of the repository is refused). Links *inside* the context are
fine as long as they are relative and stay inside the context. `harbor/` itself and the files in it must not
be links (decision 165).

What Harbor does: shallow-clones the branch, records the **commit SHA** (the provenance pin for
built services — registry digests still pin `image:` services), appends the committer date to
`release.revision` so every commit orders as a newer revision, snapshots the build contexts into
the package, and runs the same validation as a zip. At install/update time Harbor runs
`docker build` (15-minute cap, progress in the operation events) and tags the image
`harbor-src/<app>-<service>:<shortsha>`. Files reach the build with git's modes (0644, 0755 for
executables), so a `COPY` into an image that runs as a non-root user stays readable. A failed build or a failed start rolls back exactly like
any other update.

Redeploy on commit: Harbor polls the branch (`git ls-remote`, default every 15 minutes — no inbound
webhooks needed, which matters behind NAT). With the toggle on, a new commit is imported and the
update plan submitted automatically (actor `git-source`); off, you get a notification and update
manually. A commit that does not validate is recorded on the source and skipped — the running app
is never touched. `harbor sources add/check/redeploy/remove` mirror the console's Store section.

## 8. Values from the operator, and links to other apps

**Operator-provided secrets** (`source: operator`). Some apps need a value the operator already has —
another service's API token, an SMTP password. Declare it with a `prompt` (what to type, where to find
it); Harbor asks for it in the install review dialog (a password field) or takes it from the CLI
(`harbor install my-app --secret upstream-token=@token.txt`, or `=-` for stdin; a value on the command
line itself is refused). It is stored and bound exactly like a generated secret: a 0600 file in the
instance's `secrets/`, kept across remove/reinstall/update, deleted by a full uninstall, never shown in
the console, the API, plans, operation events or logs. An update asks only for operator secrets the new
release adds. The operator can replace a value later (app page → *Values you provided → Change…*, or
`harbor configure my-app --secret upstream-token=@new.txt`). `bytes`/`encoding` are for generated
secrets only; `prompt`/`optional`/`minLength`/`maxLength` for operator ones only.

**Links** (`links:`). Apps are isolated: each runs on its own private network. When your app needs
another installed app (an MCP gateway that calls a documents app's API), declare a link instead of going
out through the other app's public address. At install the operator picks which app provides it (the
only candidate is picked automatically; CLI `--link docs=<app>[/<endpoint>]`). Harbor then creates one
network for this link, joined by **only** your bound services and the provider's endpoint service (its
database and other services never join), with no route to the internet. The provider answers on it as
`<link-id>-link` on its container port, and your variables receive that address in the chosen `format`.

- The provider is attached live; it is not restarted.
- On the link network your services answer to **no name** and the provider only to `<link-id>-link`
  (decision 171): service names never count there, so naming a service `db` or `web` is fine and can
  neither catch the other app's lookups nor be caught by them. Reach the provider only through the
  variable Harbor hands you, never by its service name.
- If the provider is removed or uninstalled, the link is dropped and your app is flagged *needs a
  provider* (it keeps running without the variable after its next restart); the operator picks another
  app on its page or with `harbor configure my-app --link docs=<app>`.
- Restart re-creates the network if it went missing. Update keeps links, adds the ones a new release
  declares, and removes the ones it no longer declares.
- Use the address as a base URL (`url` has no trailing slash). Authenticate to the other app like any
  client would (often with an operator-provided secret, above): a link is reachability, not trust.


### Settings the operator can change (`settings:`, Harbor 0.34.0)

Some apps are tuned with environment variables an operator may want to change: Ollama's context length,
keep-alive, parallel requests. Declare them as `settings` (decision 180) instead of fixed literals in
`compose.yaml`, and declare `release.minHarbor: "0.34.0"` (older Harbors refuse the unknown field).

- **Types and rules.** `integer` (whole numbers; `min`/`max` optional), `number` (any finite number;
  `min`/`max`), `boolean` (`onValue`/`offValue` are what the variable gets, default `"true"`/`"false"`),
  `string` (one line, no control characters, `maxLength` 1–1024, default 256), `choice` (`choices` 1–32
  `{value, label?}`). `default` is required and must fit; rules for another type are refused (`min` on a
  boolean, `choices` on a string). Up to 32 settings, each with 1–8 `bindings` (`service`, `environment`, optional
  `template` with one `{{value}}` and no `$`, as for secrets).
- **One owner per variable.** A variable a setting binds may not also be set in `compose.yaml`'s `environment`
  (move the literal into the setting's `default`), by a secret, a link, a `configuration` binding or another
  setting.
- **What reaches the app.** Integers and numbers as written (`16384`, `0.5`), booleans as `onValue`/`offValue`,
  strings and choices as the value; then the template. A `$` in a value is passed literally (Harbor writes `$$`
  for Compose), so a value can never expand a variable. Settings reach environment variables only — never
  `command`, images or volumes.
- **Values are visible.** They appear in plans, the console, `harbor settings`, operation events, logs and
  backups. Anything secret is an operator-provided secret (above), not a setting.
- **What Harbor stores.** Only the values the operator changed (`instances/<id>/settings.json`). An app that
  kept a default follows your package: raise a default in a new revision and every such app gets it at its
  update. A stored value your new revision no longer allows (a narrower `max`, a removed choice, another type)
  goes back to the default during the update, and the update review says so; a setting you remove is dropped.
  A setting you add starts at its default (the operator may pick another in the update review).
- **Where the operator sees them.** Install review → *Options* (collapsed, defaults filled in); app page →
  *Settings → Change…* (a form, then a plan "Context length (tokens): 8192 → 16384"); CLI `--set id=value` on
  `install`/`apply`/`update`/`configure` and `harbor settings <app>`.
- Write labels the way the operator thinks ("Context length (tokens)", not `OLLAMA_CONTEXT_LENGTH`) and put
  the effect in `help`.

### Internet access (`network.internet`, Harbor 0.36.0)

Harbor can run any app **Direct**, **Through the VPN** or **Offline** (decision 184; the operator chooses per app
in its drawer, and Settings → VPN can send every app through the VPN). A package may say which one it should start
with (decision 185), and declares `release.minHarbor: "0.36.0"`:

- `offline` for an app that never needs the internet (a notes app, a local-only tool). It stays reachable the usual
  ways; it opens no connection to the internet, the home network, this machine or other apps. A Harbor link to
  another app (`links:`) still works. Its health check and `afterStart` hook run inside the container, so they are
  fine; anything that calls the app's own public address from inside (some apps check themselves that way) fails.
- `vpn` for an app whose traffic should never leave in the clear (a download client). With no VPN set up, the install
  review warns that it will have no internet until there is one.
- Leave it out (direct) for everything else, including apps that download models, plugins or feeds at runtime.

It is a default, not a permission: the operator's choice wins and is kept across your updates; an update that
changes it moves only apps that follow the default (the update review says so). Images are pulled by Docker on the
host, so offline and VPN apps update as usual.

## 9. Backup place packages (`kind: BackupTarget`)

Apps are not the only packages. A **backup place** (decision 152) is a package too: it tells Harbor
which form to show and which built-in transport to hand the answers to. It carries **no code**:
backups run as root over every app's plaintext, so a package that could run something would be a root
shell. Bundled ones live in `targets/<id>/` (`manifest.yaml` + `README.md`); uploading your own is
planned for 0.27.

```yaml
apiVersion: harbor/v1alpha1
kind: BackupTarget
metadata:
  id: mega                       # lowercase, dashes; the folder name
  name: MEGA
  description: Your MEGA account, through rclone.
  status: beta                   # stable | beta (shown as a badge)
release:
  revision: "1"
transport: rclone                # local | s3 | sftp | rclone | rest
rclone:
  backend: mega                  # any rclone backend name (https://rclone.org/overview/)
fields:
  - id: user                     # ^[a-z][A-Za-z0-9]{0,31}$
    label: Email
    type: text                   # text | secret | textarea | number
    required: true
    rclone: user                 # the rclone option this answer fills
  - id: pass
    label: Password
    type: secret                 # stored masked, never in DTOs or logs, no default allowed
    required: true
    rclone: pass
    obscure: true                # passed through `rclone obscure` (rclone wants passwords obscured)
  - id: path                     # the one field without `rclone`: the folder in the remote
    label: Folder
    type: text
    default: harbor-backups
```

Rules the loader enforces (`src/backups/targets.ts`):

- Built-in transports read fixed field ids: `local` → `path`; `s3` → `endpoint`, `bucket`,
  `accessKeyId`, `secretAccessKey` (+ optional `path`, `region`); `sftp` → `host`, `user`, `path`,
  `privateKey` (+ optional `port`, `hostKey`); `rest` → `url` (+ optional `username`, `password`). A
  field the transport does not read is refused.
- `rclone` targets need `rclone.backend`, and every field except `path` must name its rclone option.
- `obscure` and `rclone` only apply to rclone targets; a secret cannot have a default.
- Any cloud rclone supports is a new package, not a Harbor release. One rclone does not support needs
  a new transport in the engine.

## 10. Adding an app to the official catalog (harbor-apps)

The built-in apps are not in this repository. They live in
[carlosalaniz/harbor-apps](https://github.com/carlosalaniz/harbor-apps), one folder per app, in the same
package format as above (decision 158). Every change merged there reaches Harbor boxes as a new
catalog within about 6 hours, without a Harbor release.

```
harbor-apps/
  apps/index.json          id -> { revision, dir, optional minHarbor }
  apps/<id>/manifest.yaml, compose.yaml, README.md, release.json, icon.png|svg (+ screenshots)
  scripts/subset.mjs       CI helper: copies a list of apps + a filtered index.json into a folder
  scripts/require-icons.mjs CI check: every app has an icon
```

**Every official app has an icon** (2026-10-12): a square tile, .png or .svg, at most 256 KiB, readable on both the
light and dark themes (the console draws it as a rounded square). Use the project's own logo or
[dashboard-icons](https://github.com/homarr-labs/dashboard-icons); a transparent mark goes on a plain plate (white
for dark marks, dark slate for light ones), no gradients. Never Umbrel's gallery (umbrel-apps has no license).

**Contribution flow.** Clone both repositories side by side (`harbor/` and `harbor-apps/`) and run the
tools from the Harbor checkout. They find `../harbor-apps/apps` on their own; otherwise pass
`--catalog <dir>` or set `HARBOR_CATALOG_DIR`.

1. Edit `apps/<id>/`. Raise `release.revision` in the manifest **and** `revision` in `apps/index.json`
   on every change that should reach boxes as an update.
2. New or changed images: `node scripts/catalog-pin.mjs <id>` pins each `repo:tag` to its digest and
   rewrites `release.json` (no Docker needed).
3. `pnpm catalog:hash <id>` refreshes the file hashes (`--check` only reports stale ones);
   `pnpm catalog:verify` loads every app exactly as the daemon does.
4. Try it: `HARBOR_DEV_CATALOG=../harbor-apps/apps pnpm dev` shows the whole catalog in the dev console.
5. Open a pull request on harbor-apps. Its CI runs `catalog:verify` and `catalog:hash --check` with
   published Harbor releases' own loaders (see *minHarbor* below).

**Upstream updates are automatic (decision 175).** harbor-apps' `updates.yml` runs every day with the latest
Harbor release: `pnpm catalog:upstream check` finds newer tags of each app's images, `apply` moves the package to them
(re-pinned, revision + 1, the old version replaced by the new one in `release.version` and the release notes), and
`pnpm catalog:smoke` proves it on the runner's Docker with Harbor's own engine (install the current revision, update,
fresh install). Patch and minor moves land on main; majors (0.x minor too) open a pull request; failures open an
issue with Harbor's events and the containers' logs. How it chooses:

- Only tags of the **same shape** as the pinned one compete: `v0.11.3` against `v0.12.0`, never `v0.12.0-cuda`,
  `latest` or a date tag. A tag must be at least 2 days old, publish linux/amd64 and be newer than the pinned image.
- Images from one publisher on one tag **move together** (Immich's server and machine-learning), to a tag all have.
- `infrastructure` services, and databases whatever their role (postgres, mariadb, mysql, redis, valkey, mongo…),
  **stay on their major** version: a database major needs a data migration Harbor does not do.
- `updates.json` at the harbor-apps root steers it per app: `"hold": ["database"]` (never move those services),
  `"skip": "<why>"` (leave the app alone), `"match": {"web": "^2\\."}` (new tags must also match), `"note"`.

Try it locally (Docker Desktop is fine; nothing is published):

```sh
pnpm catalog:upstream check --only open-webui,immich          # what it would move
cp -R ../harbor-apps/apps /tmp/base && cp -R ../harbor-apps/apps /tmp/next
pnpm catalog:upstream apply --catalog /tmp/next freshrss web=1.30.1
pnpm catalog:smoke --docker-socket ~/.docker/run/docker.sock --catalog /tmp/next --base /tmp/base freshrss --out /tmp/smoke.json
```

`--record` writes the passed result into the package's qualification (CI does this; never by hand). The smoke run
installs a required own folder into an empty temp folder and typed-in secrets with throwaway values; an app with a
required link to another app is reported as "needs a manual check".

**minHarbor (decision 161).** An app states the oldest Harbor release it runs on in its own manifest:

```yaml
release:
  revision: "7"
  minHarbor: "0.29.0"   # optional; "x.y.z" (no leading zeros), a published Harbor release
```

- Leave it out when the app works on Harbor 0.28.0 (the first Harbor that downloads catalogs): that is
  the default. When you set it, it must be **0.28.2 or newer**, the first release that ships the field
  (0.28.0 and 0.28.1 do not know it and would refuse the manifest), so `pnpm catalog:verify` and uploads
  refuse `0.28.1` or lower. Write it the way the release is tagged: `0.28.2`, never `0.028.2` or
  `0.28.02` (leading zeros are refused).
- Set it when the app uses something a Harbor release added: a new manifest or Compose field, a new
  value, a wider limit. The Harbor release notes say which version first accepts each change. Use that
  version.
- A Harbor older than the value lists the app as unavailable ("needs Harbor x.y.z or newer"), refuses to
  install, restore or update to it, and refuses it as an upload or git source with the same message.
- `pnpm catalog:bundle` copies the value into the app's entry of the bundled `index.json`, because a
  0.28.0 box reads only the index. `apps/index.json` may leave it out; when it has one, it must equal the
  manifest's (verify, plan and bundle fail otherwise).
- `pnpm catalog:verify` prints `minHarbor=<value>` (or `minHarbor=0.28.0(default)`) for every app.
  `pnpm -s catalog:plan <apps>` prints the apps grouped by it, as one line of JSON:
  `{"groups":[{"minHarbor":"0.28.0","ids":["actual",...]},{"minHarbor":"0.28.2","ids":[...]}]}`
  (versions sorted, ids sorted; exit 1 with the reason when a declaration is invalid).

**What CI checks (the proof).** The value is your claim, and harbor-apps CI proves it instead of
trusting it:
1. the declared version must be a real published Harbor release: a GitHub release `v<x.y.z>` on
   carlosalaniz/harbor, not a draft or prerelease, whose tag commit is on Harbor's `main`;
2. the app must validate with **that** release's own validator: CI resolves the tag to its commit,
   checks that the commit is on Harbor's `main`, and checks out that exact commit (never the tag name,
   so a tag moved later cannot change what was checked). It installs that release's own toolchain
   (Node from its `package.json` engines, pnpm from its `packageManager`), runs `pnpm install`, and runs
   its `pnpm catalog:verify` on a folder holding just the apps that declare that version
   (`scripts/subset.mjs`);
3. every app also validates with the **latest** Harbor release (resolved and checked out the same way),
   which also builds the bundle.
An app's folder must be named exactly like its id (`apps/<id>/`, index entry `"dir": "<id>"`): Harbor's
catalog loader already refuses an index entry whose `dir` differs from its id, and the subset copies rely
on it.
The format only grows (below), so an app that passes on its minimum and on the latest release passes on
every release in between.

**The format only grows** (for Harbor developers changing the format itself). Every published app is
read by Harbors of every age, so:
- never remove, rename or narrow a field or value an official package may use;
- add new fields and values as optional, and widen limits and patterns, never tighten them. Say in the
  release notes which Harbor version first accepts the change, so app authors know what to put in
  `release.minHarbor`;
- index.json entry fields are not package fields: an older Harbor refuses the whole index on an unknown
  key, so a new one needs a new index schemaVersion or must stay out of the index;
- a breaking change needs a migration in the engine: Harbor adapts old packages, like Umbrel;
- unknown keys stay refused (an unknown Compose key is a security boundary).
Harbor CI's `official-catalog` job loads the latest published catalog with every Harbor commit, so a
change that breaks a published app fails before it ships.

**Qualification.** `"status": "passed"` in `release.json` only comes from a live run on a disposable
droplet: `node scripts/vm/qualify-catalog.mjs --catalog <dir>` installs each app on a box running a
Harbor archive, opens it in a real browser and writes the result into the checkout's `release.json`
files. It refuses to record anything when the box's catalog revisions differ from the checkout (build
the archive from a bundle of that checkout with `HARBOR_CATALOG_BUNDLE`, or use `--only`). Never set it
by hand. A qualification change alone needs no revision bump.

**Publishing (maintainers).** Every push to `main` of harbor-apps that touches `apps/`, `scripts/`
or the workflow (or a manual run) runs four jobs:

1. **plan** resolves the latest Harbor release to its commit (checked to be on Harbor's `main`), runs its
   `pnpm catalog:plan`, and checks every declared `release.minHarbor` is a published Harbor release,
2. **check** (one job per Harbor version, from plan) checks out that exact commit with its own Node and
   pnpm and runs its `catalog:verify` on the apps that version must accept: the latest release on every
   app, and each declared `release.minHarbor` release on the apps declaring it,
3. **bundle** (read-only, no token) refuses a committer time more than 5 minutes ahead, then runs
   `pnpm catalog:bundle <apps> --out dist --commit <sha> --serial <unix> --summary dist/summary.json` with
   the latest Harbor release, which writes `catalog.zip` (deterministic: index.json with each app's
   declared `minHarbor` copied in, plus, per app, only the package files and the assets its manifest names)
   and `catalog.json` (zip sha256 + size, commit, serial, createdAt, package count), and uploads `dist/`,
4. **publish** (the only job with write access; no checkout, no install; the token reaches only its `gh`
   steps) downloads that artifact, checks it belongs to this commit and serial, and runs
   signs `catalog.json` with the release key (secret `HARBOR_SIGNING_KEY`; the job fails without it) and runs
   `gh release create c<serial>` with `catalog.zip`, `catalog.json` and `catalog.json.sig` (release notes
   from `summary.json`), marked latest.

Since Harbor 0.32.0 (decision 168) a box uses a downloaded catalog only when Harbor's release key (the key
that also signs Harbor releases) signed its `catalog.json`; `catalog.json` then pins the zip by sha256 and
size. An unsigned or badly signed catalog is refused and the box keeps the one it has. Key custody and
rotation: `docs/design/SIGNING.md`. App authors do nothing: the catalog CI signs every release.

The serial is the commit's committer time in unix seconds. Boxes only ever move to a higher serial, so:
- a committer time more than 5 minutes in the future fails the bundle job,
- a re-run for a commit that is already released does nothing,
- a different commit in the same second as an existing release fails ("make a new commit"),
- a commit older than the latest release is skipped when `main` has moved on (the newer commit
  publishes), and fails as clock skew when it is still `main`'s tip.

Harbor releases ship the latest catalog too: `pnpm package` resolves the latest `c<serial>` tag once,
downloads both files from that tag, and refuses to build an archive whose zip does not match its
`catalog.json` or whose serial differs from the tag.

**Ids.** Official ids are reserved: uploading or importing a package with one is refused ("the id …
belongs to a built-in app"), unless you already had your own package with that id before the official
catalog added it — then yours keeps the id on your box.
