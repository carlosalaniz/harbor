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
deployment:
  compose: compose.yaml
  multiInstance: true            # false if only one copy may run
  services:
    web: application             # every compose service, marked application or infrastructure
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary     # secure if the app needs https-only browser features
health:
  endpoint: web
  path: /
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
    bindings:
      - service: web
        environment: APP_SECRET
configuration:                   # optional: hand the app its own address
  - service: web
    environment: PUBLIC_URL
    endpoint: web
    format: origin               # url | origin | authority | host | scheme
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
                                 # Mutually exclusive with defaultCredentials. The credential is shown
                                 # once in the install result and retained as an instance secret.
presentation:
  tagline: Short line shown on the card
  category: productivity         # productivity media files automation network developer ai security finance home other
  icon: icon.svg
  gallery: [shot-1.png]
  developer: You
  website: https://example.com
  releaseNotes: What changed in this revision (shown before an update)
```

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

Allowed per service: `image`, `environment` (literal values), `depends_on` (with `condition`),
`healthcheck`, `volumes` of `type: volume`. Not allowed, on purpose: `ports` (Harbor publishes the
endpoints on 127.0.0.1 itself), `command`, `privileged`, `cap_add`, `devices`, host networking, bind mounts
(operators choose folders through storage claims instead). Every named volume needs exactly one storage
claim; every claim must be mounted. Secrets and configuration bindings must not be set literally in
`environment` as well.

## 4. What Harbor does at upload

1. Reads the zip (no symlinks, no `..`, CRC checked), validates `manifest.yaml` against the schema and
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

The same mechanism updates built-in apps: a new Harbor release ships a newer catalog revision, and every
installed app from that package shows an update.

## 6. Handy commands

```sh
harbor packages                       # your uploaded packages
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

What Harbor does: shallow-clones the branch, records the **commit SHA** (the provenance pin for
built services — registry digests still pin `image:` services), appends the committer date to
`release.revision` so every commit orders as a newer revision, snapshots the build contexts into
the package, and runs the same validation as a zip. At install/update time Harbor runs
`docker build` (15-minute cap, progress in the operation events) and tags the image
`harbor-src/<app>-<service>:<shortsha>`. A failed build or a failed start rolls back exactly like
any other update.

Redeploy on commit: Harbor polls the branch (`git ls-remote`, default every 15 minutes — no inbound
webhooks needed, which matters behind NAT). With the toggle on, a new commit is imported and the
update plan submitted automatically (actor `git-source`); off, you get a notification and update
manually. A commit that does not validate is recorded on the source and skipped — the running app
is never touched. `harbor sources add/check/redeploy/remove` mirror the console's Store section.
