import { PRODUCT } from '../naming.js';
import { UNIT_MARKER } from './host.js';
import { APP_CRYPTO_UNIT_PREFIX } from '../storage/fscrypt.js';
export { APP_CRYPTO_UNIT_FILE } from '../storage/fscrypt.js';

// The unit restarts the daemon, runs it as the dedicated user with Docker group access, and kills
// only Harbor's own child processes (KillMode=control-group). App containers belong to Docker's
// cgroups, so restarting Harbor never stops them. Docker is Wanted, not Required: if Docker stops,
// Harbor stays up and reports it as unavailable instead of being stopped along with it.
export function harborUnit(opts: { lan?: boolean } = {}): string {
  return `${UNIT_MARKER}
[Unit]
Description=${PRODUCT.displayName} local application manager (preview)
Documentation=file://${PRODUCT.paths.opt}/docs/OPERATOR_GUIDE.md
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=${PRODUCT.serviceUser}
Group=${PRODUCT.serviceUser}
SupplementaryGroups=docker systemd-journal
ExecStart=${PRODUCT.paths.opt}/bin/harbor-daemon --config ${PRODUCT.paths.etc}/harbor.json
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=30
WorkingDirectory=${PRODUCT.paths.var}
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
# /mnt + /media: removable drives land here, and the drive guard stamps its
# app-generated identity marker (.harbor-bind.json) into claimed folders.
# Without these paths the daemon reads markers fine but silently fails to
# write them (ProtectSystem=strict makes /mnt read-only), so legacy markers
# never backfill and replacements stay indistinguishable.
ReadWritePaths=${PRODUCT.paths.var} ${PRODUCT.paths.data} /mnt /media
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes${opts.lan ? '\n# LAN mode: the console answers on port 80 without running as root\nAmbientCapabilities=CAP_NET_BIND_SERVICE' : ''}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
}

// Cockpit listens on all interfaces by default; this drop-in restricts it to loopback.
export function cockpitSocketDropIn(port: number): string {
  return `${UNIT_MARKER}
[Socket]
ListenStream=
ListenStream=127.0.0.1:${port}
`;
}

// polkit: let the harbor service account ask logind to reboot / power off (Settings → Restart, Shut down).
// Nothing else is granted; the daemon still runs unprivileged.
export function polkitPowerRule(): string {
  return `// ${UNIT_MARKER.replace(/^# /, '')}
polkit.addRule(function (action, subject) {
  if (subject.user !== "${PRODUCT.serviceUser}") return polkit.Result.NOT_HANDLED;
  if (action.id === "org.freedesktop.login1.reboot" ||
      action.id === "org.freedesktop.login1.reboot-multiple-sessions" ||
      action.id === "org.freedesktop.login1.power-off" ||
      action.id === "org.freedesktop.login1.power-off-multiple-sessions") {
    return polkit.Result.YES;
  }
  // restore "tailscale set --operator=harbor" after a logout wiped Tailscale's preferences (one oneshot unit, start only)
  if (action.id === "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") === "${TAILSCALE_OPERATOR_UNIT}" &&
      action.lookup("verb") === "start") {
    return polkit.Result.YES;
  }
  // Harbor updating itself: start the root oneshot for one version (harbor-self-update@<version>.service)
  if (action.id === "org.freedesktop.systemd1.manage-units" &&
      String(action.lookup("unit")).indexOf("${SELF_UPDATE_UNIT_PREFIX}") === 0 &&
      action.lookup("verb") === "start") {
    return polkit.Result.YES;
  }
  // One-click platform-tool installs from the console: start harbor-tools-install@<tool>.service
  if (action.id === "org.freedesktop.systemd1.manage-units" &&
      String(action.lookup("unit")).indexOf("harbor-tools-install@") === 0 &&
      action.lookup("verb") === "start") {
    return polkit.Result.YES;
  }
  // Removable-device mount/unmount from the console: start harbor-device-mount@<name>:<action>.service
  if (action.id === "org.freedesktop.systemd1.manage-units" &&
      String(action.lookup("unit")).indexOf("harbor-device-mount@") === 0 &&
      action.lookup("verb") === "start") {
    return polkit.Result.YES;
  }
  // Per-app kernel sealing (fscrypt): start harbor-app-crypto@<instanceId>:<action>.service
  if (action.id === "org.freedesktop.systemd1.manage-units" &&
      String(action.lookup("unit")).indexOf("${APP_CRYPTO_UNIT_PREFIX}") === 0 &&
      action.lookup("verb") === "start") {
    return polkit.Result.YES;
  }
  return polkit.Result.NOT_HANDLED;
});
`;
}
export const POLKIT_RULE_PATH = '/etc/polkit-1/rules.d/49-harbor-power.rules';
export const TAILSCALE_OPERATOR_UNIT = 'harbor-tailscale-operator.service';

// `tailscale logout` resets tailscaled's preferences, including the operator grant bootstrap made; this
// root oneshot puts it back and the harbor user may start it (polkit rule above).
export function tailscaleOperatorUnit(): string {
  return `${UNIT_MARKER}
[Unit]
Description=Let the ${PRODUCT.serviceUser} service account operate Tailscale (restored after logout)

[Service]
Type=oneshot
ExecStart=/usr/bin/tailscale set --operator=${PRODUCT.serviceUser}
`;
}

export const SELF_UPDATE_UNIT_PREFIX = 'harbor-self-update@';
export const SELF_UPDATE_UNIT_FILE = 'harbor-self-update@.service';

// Template unit: `systemctl start harbor-self-update@0.8.0.service` runs the root apply step for that version.
export function selfUpdateUnit(): string {
  return `${UNIT_MARKER}
[Unit]
Description=Harbor self-update to version %i (download, verify, in-place bootstrap)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${PRODUCT.paths.opt}/bin/harbor self-update apply --to %i
TimeoutStartSec=1800
`;
}

export const TOOLS_INSTALL_UNIT = 'harbor-tools-install.service';

// Oneshot unit for one-click platform-tool installs from the console (Cockpit/Portainer).
// The daemon (harbor user, allowed by the polkit rule) starts it with the tool id; the root
// step runs `harbor tools-install <id>`, which reuses the bootstrap recipes and records the
// result in state. Progress goes to <stateDir>/platform/<id>/install-status.json.
export function toolsInstallUnit(): string {
  return `${UNIT_MARKER}
[Unit]
Description=Harbor platform tool install (%i: cockpit or portainer)

[Service]
Type=oneshot
ExecStart=${PRODUCT.paths.opt}/bin/harbor tools-install %i
TimeoutStartSec=1800
`;
}

export const DEVICE_MOUNT_UNIT = 'harbor-device-mount.service';

// Oneshot unit for mounting/unmounting/formatting removable media from the console.
// The daemon (harbor user, allowed by the polkit rule) starts it with the device
// name and action; the root step runs `harbor device-mount <name> <mount|unmount>`
// or `harbor device-format <name>`, which validates the removable-only allowlist
// itself. Progress goes to <stateDir>/devices/<name>/{mount,format}-status.json.
export function deviceMountUnit(): string {
  const opt = PRODUCT.paths.opt;
  return `${UNIT_MARKER}
[Unit]
Description=Harbor removable-device mount (%i: <name>:<mount|unmount|format>)

[Service]
Type=oneshot
ExecStart=${opt}/bin/harbor device-dispatch %i
TimeoutStartSec=600
# FUSE filesystems (ntfs-3g, exfat) run as a userspace daemon forked from the
# mount call: the default KillMode=control-group would SIGTERM it the moment
# this oneshot exits, unmounting the drive a second later (live on
# home-server: "mounted at /mnt/usb20fd" followed by "Unmounting /dev/sdb1").
# KillMode=none lets the mount daemon survive; kernel mounts (ext4) are unaffected.
KillMode=none
`;
}

// Oneshot unit for per-app kernel sealing (fscrypt). The daemon (harbor user,
// allowed by the polkit rule) starts `harbor-app-crypto@<instanceId>:<action>`
// and BLOCKS on it; the root step runs `harbor app-crypto <spec>`, which
// re-validates the request file under <stateDir>/instances/<id>/crypto/,
// reads the app key from a FIFO there (never from disk) and writes its
// verdict to status.json. No start timeout: an in-place migration copies the
// whole app and is bounded by the data, not by us (the daemon applies
// per-action timeouts of its own).
export function appCryptoUnit(): string {
  return `${UNIT_MARKER}
[Unit]
Description=Harbor per-app encryption step (%i: <instanceId>:<setup|seal|unlock|lock|status|migrate>)

[Service]
Type=oneshot
ExecStart=${PRODUCT.paths.opt}/bin/harbor app-crypto %i
TimeoutStartSec=0
`;
}
