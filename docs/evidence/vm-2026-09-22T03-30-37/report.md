# Live VM run vm-2026-09-22T03-30-37

- Target: digitalocean droplet 601077899 ({"kind":"digitalocean","dropletId":601077899,"size":"s-4vcpu-8gb","image":"ubuntu-24-04-x64","region":"sfo3"})
- Archive: harbor-0.17.0-beta.2-linux-x64.tar.gz
- Fresh VM: false · reboot test: true
- Versions: {"ubuntu":"Ubuntu 24.04.4 LTS","arch":"x86_64","systemd":"systemd 255 (255.4-1ubuntu8.16)","docker":"29.8.1","compose":"5.5.1","node":"v24.12.0","harbor":"0.17.0-beta.2"}
- Started 2026-09-22T03:30:37.804Z, finished 2026-09-22T03:34:03.584Z

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| A01 | Clean VM bootstrap without Node/npm; re-run preserves identity/admin/app state | **PASS** | VM NOT rebuilt (--fresh not given); A01 evidence is from a re-used VM<br>Docker 29.8.1 / Compose 5.5.1 installed by bootstrap; Node v24.12.0 bundled<br>bootstrap re-run kept installation id and administrator |
| C01 | Per-app kernel sealing: Local install is fscrypt-sealed; Lock = ciphertext + ENOKEY even via a Docker bypass; Start unlocks; reboot re-locks (A09) | **PASS** | memos installed sealed at /srv/harbor/harbor-apps/memos/sealed-demo (fscrypt v2 raw_key protector, sealed before volumes were rooted)<br>Docker bind of the sealed dir: plaintext while unlocked; ciphertext names + "Required key not available" + failed write while locked<br>Lock refused while running; Stop → Lock → Start restored access with the machine key |
| A09 | Daemon restart leaves apps running; host reboot returns desired-running apps; intentional stop stays stopped | **PASS** | daemon restart: container ids/creation unchanged; UI recovered after login<br>sealed-demo (C01) read Locked with ciphertext names after the reboot, before any login<br>sealed-demo unlocked silently by the login and came back healthy (lock-guard auto-start)<br>host reboot (2026-09-22 01:18:37 -> 2026-09-22 03:32:48): desired-running apps healthy again, excalidraw-2 stayed stopped |

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
