#!/bin/bash
# ssh into the designated harbor-test droplet (reads .vm.local.json). Usage: scripts/vm/vm-ssh.sh [ssh-options...] -- <command>
set -euo pipefail
cd "$(dirname "$0")/../.."
IP=$(node -p 'JSON.parse(require("fs").readFileSync(".vm.local.json","utf8")).ip')
KEY="${HARBOR_VM_SSH_KEY:-$HOME/.ssh/harbor-test-vm_ed25519}"
OPTS=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do OPTS+=("$1"); shift; done
[ "${1:-}" = "--" ] && shift
exec ssh -i "$KEY" -o UserKnownHostsFile=.vm-known_hosts -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ServerAliveInterval=15 ${OPTS[@]+"${OPTS[@]}"} "root@$IP" "$@"
