# Live VM run vm-2026-09-14T18-08-26

- Target: digitalocean droplet 600403086 (143.198.73.104) ({"kind":"digitalocean","dropletId":600403086,"size":"s-4vcpu-8gb","image":"ubuntu-24-04-x64","region":"sfo3"})
- Archive: harbor-0.1.0-linux-x64.tar.gz
- Fresh VM: true · reboot test: true
- Versions: {}
- Started 2026-09-14T18:08:26.699Z, finished 2026-09-14T18:10:08.212Z

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| A01 | Clean VM bootstrap without Node/npm; re-run preserves identity/admin/app state | **FAIL** | ssh command failed (exit 255): DEBIAN_FRONTEND=noninteractive apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends cockpit
Read from remote host 143.198.73.104: Connection reset by peer
client_loop: send disconnect: Broken pipe

e.ubuntu.com/ubuntu noble-updates/restricted amd64 Packages [1544 kB]
Get:13 http://sfo3.clouds.archive.ubuntu.com/ubuntu noble-updates/restricted Translation-en [354 kB]
Get:14 http://sfo3.clouds.archive.ubuntu.com/ubuntu noble-updates/multiverse amd64 Packages [45.4 kB]
Get:15 http://sfo3.clouds.archive.ubuntu.com/ubuntu noble-updates/multiverse Translation-en [12.8 kB]
Get:16 http://sfo3.clouds.archive.ubuntu.com/ubuntu noble-updates/multiverse amd64 Components [940 B]
Get:17 http://sfo3.clouds.archive.ubuntu.com/ubuntu noble-backports/main amd64 Components [5772 B]
Get:18 http://sfo3.clouds.archive.ubuntu.com/ubuntu noble-backports/universe amd64 Packages [31.0 kB]
Get:19 http://sfo3.clouds.archive.ubuntu.com/ubuntu noble-backports/universe amd64 Components [12.6 kB]
Get:20 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]
Get:21 http://security.ubuntu.com/ubuntu noble-security/main amd64 Packages [1007 kB]
Get:22 http://security.ubuntu.com/ubuntu noble-security/main Translation-en [213 kB]
Get:23 http://security.ubuntu.com/ubuntu noble-security/main amd64 Components [46.4 kB]
Get:24 http://security.ubuntu.com/ubuntu noble-security/main amd64 c-n-f Metadata [11.9 kB]
Get:25 http://security.ubuntu.com/ubuntu noble-security/universe amd64 Packages [1207 kB]
Get:26 http://security.ubuntu.com/ubuntu noble-security/universe Translation-en [242 kB]
Get:27 http://security.ubuntu.com/ubuntu noble-security/universe amd64 Components [76.3 kB]
Get:28 http://security.ubuntu.com/ubuntu noble-security/universe amd64 c-n-f Metadata [24.2 kB]
Get:29 http://security.ubuntu.com/ubuntu noble-security/restricted amd64 Packages [1445 kB]
Get:30 http://security.ubuntu.com/ubuntu noble-security/restricted Translation-en [336 kB]
Get:31 http://security.ubuntu.com/ubuntu noble-security/multiverse amd64 Packages [40.3 kB]
Get:32 http://security.ubuntu.com/ubuntu noble-security/multiverse Translation-en [11.1 kB]
Fetched 11.3 MB in 12s (968 kB/s)
Reading package lists... |

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
