import { PRODUCT } from '../naming.js';
import { UNIT_MARKER } from './host.js';

// The unit restarts the daemon, runs it as the dedicated user with Docker group access, and kills
// only Harbor's own child processes (KillMode=control-group). App containers belong to Docker's
// cgroups, so restarting Harbor never stops them. Docker is Wanted, not Required: if Docker stops,
// Harbor stays up and reports it as unavailable instead of being stopped along with it.
export function harborUnit(): string {
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
SupplementaryGroups=docker
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
ReadWritePaths=${PRODUCT.paths.var} ${PRODUCT.paths.data}
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
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
  if (subject.user === "${PRODUCT.serviceUser}" &&
      (action.id === "org.freedesktop.login1.reboot" ||
       action.id === "org.freedesktop.login1.reboot-multiple-sessions" ||
       action.id === "org.freedesktop.login1.power-off" ||
       action.id === "org.freedesktop.login1.power-off-multiple-sessions")) {
    return polkit.Result.YES;
  }
});
`;
}
export const POLKIT_RULE_PATH = '/etc/polkit-1/rules.d/49-harbor-power.rules';
