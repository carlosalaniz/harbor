// Removable-device mount/unmount orchestration: validates against the live device
// list, refuses while an app holds a bind claim under the mountpoint, starts the
// root oneshot (polkit-allowed), and reports the root step's progress from
// <stateDir>/devices/<name>/mount-status.json. In fake mode there is no systemd:
// refuse with the exact root command.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readDeviceMountStatus, type DeviceMountStatus } from '../bootstrap/device-mount-apply.js';
import { listDevices } from '../system/host-storage.js';
import type { Repo } from '../state/repo.js';
import type { Clock } from '../util.js';
import { rfc3339 } from '../util.js';
import { HarborError } from '../errors.js';

export class DeviceMountService {
  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    private readonly stateDir: string = '',
    private readonly mountStarter: ((unit: string) => Promise<void>) | null = null,
    // E2E/dev seam: HARBOR_DEVICES_JSON mode has no systemd and no real mount,
    // so simulate the root oneshot (requested → mounted/unmounted) in-process.
    private readonly simulateRoot: boolean = process.env['HARBOR_DEVICES_JSON'] !== undefined,
  ) {}

  status(name: string): DeviceMountStatus | null {
    if (!this.stateDir) return null;
    try {
      return readDeviceMountStatus(this.stateDir, name);
    } catch {
      return null;
    }
  }

  async mount(name: string, actor: string): Promise<DeviceMountStatus> {
    const dev = listDevices().find((d) => d.name === name);
    if (!dev) throw new HarborError('NOT_FOUND', `device ${name} not found`, { nextAction: 'Re-insert the drive and retry.' });
    if (!dev.removable) throw new HarborError('INVALID_REQUEST', `device ${name} is not removable media`, { nextAction: 'Harbor only mounts removable drives.' });
    if (dev.mounted && dev.mountpoint) return { device: name, state: 'mounted', message: `already mounted at ${dev.mountpoint}`, mountpoint: dev.mountpoint, at: rfc3339(this.clock.now()) };
    const st = this.status(name);
    if (st && (st.state === 'requested' || st.state === 'mounting' || st.state === 'unmounting')) throw new HarborError('BUSY', `a mount operation for ${name} is already running (${st.message})`);
    if (this.simulateRoot) {
      // Fake-hardware mode: no systemd, no real mount. Complete the oneshot
      // in-process after a beat so the UI's Mounting… spinner is exercised.
      this.writeStatus(name, 'requested', `requested by ${actor}; starting the mount`, null);
      const mp = `/mnt/${name}`;
      setTimeout(() => this.writeStatus(name, 'mounted', `mounted at ${mp}`, mp), 1200).unref?.();
      return { device: name, state: 'requested', message: 'mount requested', mountpoint: null, at: rfc3339(this.clock.now()) };
    }
    if (!this.mountStarter) throw new HarborError('UNSUPPORTED_CAPABILITY', 'device mount is not available on this machine', { nextAction: `On the machine, run: sudo /opt/harbor/bin/harbor device-mount ${name}:mount` });
    this.writeStatus(name, 'requested', `requested by ${actor}; starting the mount`, null);
    try {
      await this.mountStarter(`harbor-device-mount@${name}:mount.service`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.writeStatus(name, 'failed', `could not start the mount: ${msg}`, null);
      throw new HarborError('OPERATION_FAILED', `Harbor could not start the mount (${msg})`, { nextAction: `On the machine, run: sudo /opt/harbor/bin/harbor device-mount ${name}:mount` });
    }
    return this.status(name) ?? { device: name, state: 'requested', message: 'mount requested', mountpoint: null, at: rfc3339(this.clock.now()) };
  }

  async unmount(name: string, actor: string): Promise<DeviceMountStatus> {
    const dev = listDevices().find((d) => d.name === name);
    if (!dev) throw new HarborError('NOT_FOUND', `device ${name} not found`);
    if (!dev.mounted || !dev.mountpoint) return { device: name, state: 'unmounted', message: 'not mounted', mountpoint: null, at: rfc3339(this.clock.now()) };
    // Refuse while an app holds a folder on this mount: yanking a live library corrupts writes.
    const holders = this.repo
      .resourcesByKind('bind')
      .filter((r) => r.name === dev.mountpoint || r.name.startsWith(dev.mountpoint + '/'));
    if (holders.length) {
      const names = [...new Set(holders.map((h) => this.repo.instance(h.instanceId)?.name ?? h.instanceId))].join(', ');
      throw new HarborError('INVALID_STATE', `${dev.mountpoint} is in use by ${names}`, { nextAction: 'Move the app data elsewhere or remove the app first; Harbor never unmounts a drive out from under an app.' });
    }
    const st = this.status(name);
    if (st && (st.state === 'requested' || st.state === 'mounting' || st.state === 'unmounting')) throw new HarborError('BUSY', `a mount operation for ${name} is already running (${st.message})`);
    if (this.simulateRoot) {
      this.writeStatus(name, 'requested', `requested by ${actor}; starting the unmount`, dev.mountpoint);
      setTimeout(() => this.writeStatus(name, 'unmounted', 'unmounted', null), 1200).unref?.();
      return { device: name, state: 'requested', message: 'unmount requested', mountpoint: dev.mountpoint, at: rfc3339(this.clock.now()) };
    }
    if (!this.mountStarter) throw new HarborError('UNSUPPORTED_CAPABILITY', 'device unmount is not available on this machine', { nextAction: `On the machine, run: sudo /opt/harbor/bin/harbor device-mount ${name}:unmount` });
    this.writeStatus(name, 'requested', `requested by ${actor}; starting the unmount`, dev.mountpoint);
    try {
      await this.mountStarter(`harbor-device-mount@${name}:unmount.service`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.writeStatus(name, 'failed', `could not start the unmount: ${msg}`, dev.mountpoint);
      throw new HarborError('OPERATION_FAILED', `Harbor could not start the unmount (${msg})`, { nextAction: `On the machine, run: sudo /opt/harbor/bin/harbor device-mount ${name}:unmount` });
    }
    return this.status(name) ?? { device: name, state: 'requested', message: 'unmount requested', mountpoint: dev.mountpoint, at: rfc3339(this.clock.now()) };
  }

  private writeStatus(name: string, state: DeviceMountStatus['state'], message: string, mountpoint: string | null): void {
    if (!this.stateDir) return;
    try {
      const dir = path.join(this.stateDir, 'devices', name);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, 'mount-status.json'), JSON.stringify({ device: name, state, message, mountpoint, at: rfc3339(this.clock.now()) }), { mode: 0o600 });
    } catch {
      /* status is best effort */
    }
  }
}
