# Public-path proof — fresh droplet `harbor-test-3` (2026-09-15)

First end-to-end run of the **public** install and update paths after the repository became public
(decision 75). Droplet: `harbor-test-3` (id 600780190, Ubuntu 24.04 x86-64, s-4vcpu-8gb, sfo3), created
for this run; `harbor-test` and `harbor-test-2` untouched. VM IP redacted as `<ip>` by the vm scripts.

| Check | Result |
|---|---|
| `curl -fsSL https://raw.githubusercontent.com/carlosalaniz/harbor/main/install.sh \| sudo bash` on a bare machine | **PASS** — downloaded release v0.8.1 from GitHub, verified SHA256SUMS, installed Docker 29.8.1 / Compose 5.5.1, avahi-daemon, hostname `harbor`, Tailscale + Caddy; daemon healthy; no terminal prompt; printed `Finish setup in a browser: http://harbor.local/` and `Setup code: 261381` |
| Setup wizard through an SSH tunnel (`-L 18000:127.0.0.1:18000`) | **PASS** — named the machine *Public Proof*, created account `carlos` with the printed code, `GET /v1/setup` → `needed:false` ([setup-after.json](setup-after.json)) |
| GitHub-feed detection of a newer release | **PASS** — Settings → Overview → *Check now* after publishing v0.8.2: "Version 0.8.2 is available" |
| Self-update 0.8.1 → 0.8.2 from the console (*Update now*) | **PASS** — polkit-started `harbor-self-update@0.8.2.service` downloaded the archive from GitHub, verified the checksum (`f932e40f…`, matching the locally built archive), ran in-place bootstrap, restarted the daemon; `status.json` `succeeded`, console reconnected showing "Harbor 0.8.2 · Updated to 0.8.2." ([self-update-0.8.2.log](self-update-0.8.2.log)) |

Total wall time for the update: ~13 s (download 3 s, verify, bootstrap ~6 s, restart).

Files: [install-summary.log](install-summary.log) (daemon logs, mDNS, final setup state),
[setup-after.json](setup-after.json), [self-update-0.8.2.log](self-update-0.8.2.log).
Console screenshots: home after the wizard and Settings → Overview after the update (session captures).
