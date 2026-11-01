import { PRODUCT } from '../naming.js';
import { UNIT_MARKER } from './host.js';
import { APP_CRYPTO_UNIT_PREFIX } from '../storage/fscrypt.js';
import { BACKUP_UNIT_PREFIX } from '../backups/step.js';
import { EGRESS_UNIT_PREFIX } from '../egress/provider.js';
import { KERNEL_UNIT_PREFIX } from '../system/kernel.js';
export { BACKUP_UNIT_FILE } from '../backups/step.js';
export { EGRESS_BOOT_UNIT, EGRESS_UNIT_FILE, VPN_UNIT } from '../egress/provider.js';
export { APP_CRYPTO_UNIT_FILE } from '../storage/fscrypt.js';
export { KERNEL_UNIT_FILE } from '../system/kernel.js';

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
  // App backups (restic): start harbor-backup@<requestId>.service
  if (action.id === "org.freedesktop.systemd1.manage-units" &&
      String(action.lookup("unit")).indexOf("${BACKUP_UNIT_PREFIX}") === 0 &&
      action.lookup("verb") === "start") {
    return polkit.Result.YES;
  }
  // VPN and offline apps (decision 184): start harbor-egress@<apply|tunnel-set|tunnel-remove|status>.service
  if (action.id === "org.freedesktop.systemd1.manage-units" &&
      String(action.lookup("unit")).indexOf("${EGRESS_UNIT_PREFIX}") === 0 &&
      action.lookup("verb") === "start") {
    return polkit.Result.YES;
  }
  // Android's binder driver for apps with the binder permission (decision 193): start harbor-kernel@binder.service
  if (action.id === "org.freedesktop.systemd1.manage-units" &&
      String(action.lookup("unit")).indexOf("${KERNEL_UNIT_PREFIX}") === 0 &&
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
# decision 168: inside this unit the CLI refuses --allow-downgrade / --allow-unsigned
Environment=HARBOR_SELF_UPDATE_UNIT=1
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

// Oneshot unit for app backups (decision 153). The daemon starts `harbor-backup@<requestId>` and
// BLOCKS on it; the root step runs `harbor backup-step <requestId>`, which re-validates the request
// under <stateDir>/backup/requests/<id>/, reads its secrets from a FIFO there and runs restic. No start
// timeout: a first backup is bounded by the data and the uplink; the request carries its own deadline.
export function backupUnit(): string {
  return `${UNIT_MARKER}
[Unit]
Description=Harbor app backup step (%i: request id)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${PRODUCT.paths.opt}/bin/harbor backup-step %i
TimeoutStartSec=0
Nice=5
`;
}

// VPN and offline apps (decision 184, docs/design/VPN.md). The daemon starts `harbor-egress@<action>` and BLOCKS on
// it; the root step re-validates the request under <stateDir>/egress/, reads the WireGuard file from a FIFO there,
// loads the firewall/routing/tunnel and writes its verdict to status.json.
export function egressStepUnit(): string {
  return `${UNIT_MARKER}
[Unit]
Description=Harbor VPN and offline apps step (%i: apply, tunnel-set, tunnel-remove or status)

[Service]
Type=oneshot
ExecStart=${PRODUCT.paths.opt}/bin/harbor egress-step %i
TimeoutStartSec=120
`;
}

// Decision 193: the daemon starts `harbor-kernel@binder` and BLOCKS on it; the root step loads binder_linux and writes
// Harbor's modules-load.d/modprobe.d files so systemd-modules-load loads it at every boot, before Docker starts.
export function kernelStepUnit(): string {
  return `${UNIT_MARKER}
[Unit]
Description=Harbor kernel driver step (%i: load it now and at every boot)

[Service]
Type=oneshot
ExecStart=${PRODUCT.paths.opt}/bin/harbor kernel-step %i
TimeoutStartSec=60
`;
}

// Boot, before Docker starts any container: the last ruleset that loaded, with nft alone (no Harbor code, no
// parsing), then Harbor's routing rules. Docker requires this unit, so no app runs without its rules; a machine
// that never used VPN or offline apps has no rules file and the unit is skipped (a skipped condition is no failure).
export function egressBootUnit(): string {
  return `${UNIT_MARKER}
[Unit]
Description=Harbor firewall for VPN and offline apps (loaded before Docker starts)
Before=docker.service
ConditionPathExists=${PRODUCT.paths.etc}/egress/rules.nft

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f ${PRODUCT.paths.etc}/egress/rules.nft
# routing only: the firewall above already refuses what a VPN app sends outside the tunnel
ExecStart=-${PRODUCT.paths.opt}/bin/harbor egress-boot

[Install]
RequiredBy=docker.service
WantedBy=multi-user.target
`;
}

// The tunnel needs the network (its server may be a name to resolve): retried until it comes up. Until then the
// firewall keeps VPN apps without internet.
export function vpnUnit(): string {
  return `${UNIT_MARKER}
[Unit]
Description=Harbor VPN tunnel for apps
After=network-online.target harbor-egress.service
Wants=network-online.target
ConditionPathExists=${PRODUCT.paths.etc}/egress/tunnel.conf
StartLimitIntervalSec=0

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${PRODUCT.paths.opt}/bin/harbor egress-tunnel-up
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
`;
}
