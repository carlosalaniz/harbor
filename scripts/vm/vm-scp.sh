#!/bin/bash
# copy files to the designated harbor-test droplet. Usage: scripts/vm/vm-scp.sh <local...> <remote-path>
set -euo pipefail
cd "$(dirname "$0")/../.."
STATE="${HARBOR_VM_STATE:-.vm.local.json}"
IP=$(node -p "JSON.parse(require('fs').readFileSync('$STATE','utf8')).ip")
KEY="${HARBOR_VM_SSH_KEY:-$HOME/.ssh/harbor-test-vm_ed25519}"
args=("$@"); last="${args[${#args[@]}-1]}"; unset 'args[${#args[@]}-1]'
exec scp -q -i "$KEY" -o UserKnownHostsFile="${HARBOR_VM_KNOWN_HOSTS:-.vm-known_hosts}" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "${args[@]}" "root@$IP:$last"
