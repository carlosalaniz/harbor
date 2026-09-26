import { describe, expect, it } from 'vitest';
import { uninstallPreview } from '../../src/bootstrap/uninstall.js';
import type { HostFacts } from '../../src/bootstrap/host.js';

function facts(over: Partial<HostFacts['existing']> = {}): HostFacts {
  return {
    osId: 'ubuntu',
    versionId: '24.04',
    prettyName: 'Ubuntu 24.04',
    arch: 'x64',
    systemd: true,
    root: true,
    docker: { binary: '/usr/bin/docker', version: '28.0', composeVersion: '2.0', daemonActive: true, socket: '/var/run/docker.sock' },
    existing: { optDir: 'harbor', optReleaseVersion: '0.10.0', config: true, state: true, unit: 'harbor', user: true, cockpit: { installed: false, socketActive: false }, portainer: { containerPresent: false }, tailscale: { installed: false, backendState: null, dnsName: null }, caddy: { installed: false, adminReachable: false, harborConfig: false }, ...over },
  };
}

describe('uninstall preview', () => {
  it('lists every Harbor-owned removal and names what stays', () => {
    const lines = uninstallPreview(facts(), { keepData: false });
    const text = lines.join('\n');
    expect(text).toContain('Stop and disable systemd unit harbor.service');
    expect(text).toContain('io.harbor.preview/installation');
    expect(text).toContain('hb_platform_*');
    expect(text).toContain('/opt/harbor');
    expect(text).toContain('/etc/harbor');
    expect(text).toContain('/var/lib/harbor');
    expect(text).toContain('/srv/harbor');
    expect(text).toContain('harbor.service');
    expect(text).toContain('harbor-device-mount@.service');
    expect(text).toContain('49-harbor-power.rules');
    expect(text).toContain('Delete service user harbor');
    expect(text).toContain('and its group');
    expect(text).toContain('Leave untouched');
  });
  it('--keep-data keeps state; foreign unit and release are never deleted', () => {
    const keep = uninstallPreview(facts(), { keepData: true }).join('\n');
    expect(keep).toContain('Keep /var/lib/harbor');
    const foreign = uninstallPreview(facts({ unit: 'foreign', optDir: 'foreign' }), { keepData: false }).join('\n');
    expect(foreign).toContain('Keep foreign systemd unit harbor.service');
    expect(foreign).toContain('Keep foreign /opt/harbor');
  });
});
