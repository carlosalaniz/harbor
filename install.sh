#!/usr/bin/env bash
# Harbor one-line installer for Ubuntu 24.04 x86-64.
#
#   curl -fsSL https://raw.githubusercontent.com/carlosalaniz/harbor/main/install.sh | sudo bash
#
# What it does (each step is printed): checks the machine, installs Docker if needed, downloads the newest
# Harbor release from GitHub and verifies its checksum, names the machine `harbor` (so it answers as
# http://harbor.local on your network through mDNS), installs Harbor, and prints the setup code for the
# browser wizard where you create your account. Nothing is asked on the terminal.
#
# Options (environment variables):
#   HARBOR_VERSION=0.8.0     install a specific release instead of the newest
#   HARBOR_HOSTNAME=harbor   mDNS name (default harbor -> http://harbor.local); empty keeps the current hostname
#   HARBOR_LAN=auto|on|off   LAN mode (default auto: on when the machine has a private-network address)
#   HARBOR_TOOLS=1           also set up Cockpit and Portainer
#   HARBOR_REPO=owner/name   GitHub repository (default carlosalaniz/harbor)
set -euo pipefail

REPO="${HARBOR_REPO:-carlosalaniz/harbor}"
WANT_HOSTNAME="${HARBOR_HOSTNAME-harbor}"
LAN="${HARBOR_LAN:-auto}"
WORK=/root/harbor-install

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sudo bash"
command -v curl >/dev/null || die "curl is required (apt-get install -y curl)"
command -v tar  >/dev/null || die "tar is required"

say "Checking this machine"
. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
[ "${ID:-}" = "ubuntu" ] && [[ "${VERSION_ID:-}" == 24.04* ]] || die "Harbor supports Ubuntu 24.04 LTS (this is ${PRETTY_NAME:-unknown})"
[ "$(uname -m)" = "x86_64" ] || die "Harbor supports x86-64 machines (this is $(uname -m))"
[ -d /run/systemd/system ] || die "systemd is required"
FREE_KB=$(df --output=avail -k / | tail -1)
[ "$FREE_KB" -ge 8000000 ] || die "at least 8 GB of free disk space is needed on / (have $((FREE_KB/1024/1024)) GB)"
MEM_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
[ "$MEM_KB" -ge 1800000 ] || warn "less than 2 GB of memory; small apps only"
curl -fsS --max-time 15 -o /dev/null "https://api.github.com/repos/$REPO/releases" || die "cannot reach GitHub (api.github.com)"
echo "    ${PRETTY_NAME}, x86-64, $((MEM_KB/1024/1024)) GB memory, $((FREE_KB/1024/1024)) GB free"

say "Finding the newest Harbor release"
if [ -n "${HARBOR_VERSION:-}" ]; then
  VERSION="$HARBOR_VERSION"
else
  VERSION=$(curl -fsSL --max-time 20 "https://api.github.com/repos/$REPO/releases?per_page=10" | grep -o '"tag_name": *"v[0-9][0-9.]*"' | grep -o 'v[0-9][0-9.]*' | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
  [ -n "$VERSION" ] || die "no release found in $REPO"
fi
ARCHIVE="harbor-${VERSION}-linux-x64.tar.gz"
BASE="https://github.com/$REPO/releases/download/v${VERSION}"
echo "    Harbor $VERSION"

say "Downloading and verifying $ARCHIVE"
mkdir -p "$WORK"; cd "$WORK"
curl -fSL --progress-bar -o "$ARCHIVE" "$BASE/$ARCHIVE"
curl -fsSL -o SHA256SUMS "$BASE/SHA256SUMS"
grep " $ARCHIVE\$" SHA256SUMS | sha256sum -c - >/dev/null || die "checksum mismatch for $ARCHIVE"
rm -rf "harbor-${VERSION}-linux-x64"
tar -xzf "$ARCHIVE"
echo "    checksum OK"

# LAN mode: on when there is a private-network address (home/office); a cloud server would expose everything
HAS_PRIVATE=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | grep -Ec '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' || true)
LAN_FLAGS=""
case "$LAN" in
  on)   LAN_FLAGS="--lan --lan-force" ;;
  off)  LAN_FLAGS="" ;;
  *)    if [ "$HAS_PRIVATE" -gt 0 ]; then LAN_FLAGS="--lan"; else warn "no private-network address found (cloud server?): LAN mode stays off; use Tailscale or SSH forwarding to reach Harbor"; fi ;;
esac
HOST_FLAGS=""
if [ -n "$WANT_HOSTNAME" ] && [ "$(hostname)" != "$WANT_HOSTNAME" ]; then HOST_FLAGS="--hostname $WANT_HOSTNAME"; fi
TOOL_FLAGS="--with-tailscale --with-public-proxy"
[ "${HARBOR_TOOLS:-0}" = "1" ] && TOOL_FLAGS="$TOOL_FLAGS --with-tools"

say "Installing Harbor $VERSION (Docker, mDNS, Tailscale, HTTPS proxy; a few minutes)"
# shellcheck disable=SC2086
"./harbor-${VERSION}-linux-x64/bin/harbor" bootstrap --yes --install-docker --setup-in-browser $TOOL_FLAGS $LAN_FLAGS $HOST_FLAGS
