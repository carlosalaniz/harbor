# Live: redroid stack + binder root step on harbor-old (2026-11-01, Harbor 0.40.0 build, decision 193)

Host: harbor-old (Kubuntu 24.04, kernel 6.8.0-147-generic, Docker 29.8.1, Compose 2.29.2), self-updated as root to the
local 0.40.0 archive (`--allow-unsigned`).

| Check | Result |
|---|---|
| `harbor-kernel@.service` + polkit rule installed by bootstrap | present |
| `sudo -u harbor systemctl start harbor-kernel@binder.service` (polkit, as the daemon does) | exit 0 in 0.4 s; `nodev binder` in `/proc/filesystems`, `binder_linux` loaded; both Harbor-marked `/etc` files written; status `ok` |
| `harbor-kernel@nvidia.service` | refused (exit 1): only `binder` is a known module |
| redroid 15.0.0-250627 alone (privileged, package boot arguments, package health check) | healthy after 16 s |
| apps/redroid compose (privileged rendered by hand, as Harbor renders the permission; proxy published on loopback) | `up --wait` 12 s; `/harbor-health` 200 without login; `/` 401 without or with a wrong login, 200 with it; `adb devices` in `screen`: `android:5555 device` |
| Browser (Playwright, through an SSH tunnel, basic auth) | device list shows `redroid redroid15_x86_64`; Broadway player streams the home screen (`android-home.png`); a mouse swipe opens the app drawer (`android-swipe.png`) |

Not covered here: the install through Harbor's own plan/approve flow on this box (its CLI session had expired); that
path is covered by `tests/integration/developer-mode.test.ts` (fake Docker) and the harbor-apps smoke run.
`devmode-banner.png`: the console in design mode with developer mode on.
