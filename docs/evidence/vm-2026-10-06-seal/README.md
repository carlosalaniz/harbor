# Live run: `harbor seal`, passphrase change, sealed purge (Harbor 0.24.0, 2026-10-06)

Droplet `harbor-test` (Ubuntu 24.04 x86-64, ext4 root with `encrypt`, DigitalOcean; address redacted).
Harbor self-updated **0.20.1 → 0.24.0** from a local archive (`harbor self-update apply --to 0.24.0
--archive …`): schema migrated, daemon up, existing apps untouched, `harbor list` showed the new
ENCRYPTED column (`sealed-demo yes`, every older CLI install `no`).

| Step | Command | Result |
|---|---|---|
| plain install | `harbor install memos --name seal-live --unencrypted --yes` | plan said `Encrypted: no` + the "Not encrypted" warning; volume `hb_f7d2…_data` |
| marker data | `docker exec … head -c 5000000 /dev/urandom > /var/opt/memos/marker/blob` | sha256 `d69b00ba…5974` |
| seal | `harbor seal seal-live --yes` | home `/srv/harbor/harbor-apps/memos/seal-live` created + kernel-sealed, `copied and verified hb_f7d2…_data`, readiness 200 on the same port 18092, plain volume deleted last; only `hb_f7d2…_data-sealed` remains |
| data kept | `docker exec … sha256sum` | `d69b00ba…5974` (same) |
| kernel | `fscrypt status <home>/volumes` | policy present, `Unlocked: Yes` |
| at rest | `harbor stop` + `harbor lock`, `ls <home>/volumes/*/` | only ciphertext names (`WkxJLbtu…`, `SPp12tVx…`) |
| reopen | `harbor start seal-live` | succeeded, same sha256 |
| own passphrase | `printf "\nnew\n" \| harbor passphrase seal-live --stdin` | new passphrase, own 12 words issued once |
| lock / unlock with it | `harbor lock`, `harbor unlock --passphrase-stdin`, `harbor start` | unlocked for this boot, same sha256 |
| back to Harbor key | `harbor passphrase seal-live --harbor-key --stdin` | `encrypted: yes — … (unlocked, Harbor's own key)` |
| remove / reinstall | `harbor remove` + `harbor reinstall` | same sha256 on the sealed volume |
| purge (first try, 0.24.0 build 1) | `harbor purge seal-live --yes` | **failed: EACCES** deleting the home — container-owned files; fixed by decision 144 |
| purge (fixed build) | redeployed, `harbor purge seal-live --yes` | succeeded; home and volumes gone |

Not covered here: tailnet own-port and remove/reinstall of addresses (0.23.0) need a tailnet login /
public DNS; they are fake-adapter evidence only (VERIFICATION §3k).
