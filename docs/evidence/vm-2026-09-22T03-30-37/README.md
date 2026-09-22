# vm-2026-09-22T03-30-37 — true at-rest sealing (Harbor 0.17.0-beta.2, decision 103)

`pnpm test:vm -- --only A01,C01,A09` against the existing `harbor-test` droplet (Ubuntu 24.04
x86-64, not rebuilt). Proves that a Local install is fscrypt-sealed before any data exists, that
Lock makes the data ciphertext for every reader (Docker bind bypass: ciphertext names, `Required
key not available`, failed write), that Start restores access, and that a host reboot returns the
app to locked until the first login. `report.json` carries the raw `fscrypt status`, `ls` and
bypass output; `bootstrap-1.log` shows `per-app encryption ready on / (ext4, /dev/vda1)`.
VM IPs are redacted.
