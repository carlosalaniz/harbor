import { describe, expect, it } from 'vitest';
import { cockpitSocketDropIn, harborUnit } from '../../src/bootstrap/systemd.js';

describe('systemd unit text', () => {
  it('runs as the harbor user with docker group, control-group kill, and does not stop when Docker stops', () => {
    const unit = harborUnit();
    expect(unit).toContain('User=harbor');
    expect(unit).toContain('SupplementaryGroups=docker');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('Wants=network-online.target docker.service');
    expect(unit).not.toMatch(/^Requires=.*docker/m); // live A10 found Harbor being stopped along with Docker
    expect(unit).toContain('ReadWritePaths=/var/lib/harbor /srv/harbor'); // the data folder must be writable for the folder picker
    expect(unit).toContain('# managed-by: harbor-bootstrap');
  });
  it('restricts the Cockpit socket to loopback', () => {
    expect(cockpitSocketDropIn(9090)).toContain('ListenStream=\nListenStream=127.0.0.1:9090');
  });
});
