// Removable-device mount/unmount/format orchestration: validates against the
// live device list, refuses while an app holds a bind claim or an app home
// under the mountpoint, starts the root oneshot (polkit-allowed), and reports
// the root step's progress from <stateDir>/devices/<name>/{mount,format}-status.json.
// In fake mode there is no systemd: refuse with the exact root command.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readDeviceMountStatus, type DeviceMountStatus } from '../bootstrap/device-mount-apply.js';
import { readDeviceFormatStatus, type DeviceFormatStatus } from '../bootstrap/device-format-apply.js';
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

  formatStatus(name: string): DeviceFormatStatus | null {
    if (!this.stateDir) return null;
    try {
      return readDeviceFormatStatus(this.stateDir, name);
    } catch {
      return null;
    }
  }

  // Format a removable drive as ext4 so it can hold encrypted apps. Refused
  // while any app uses the drive — either a bring-your-own folder (bind) or
  // an app home (volume role __home__) at or under its mountpoint, or an
  // unmounted device whose mountpoint cannot be proven free. The wipe itself
  // runs as root (same template unit as mount/unmount); progress is polled
  // through formatStatus() until it settles.
  async format(name: string, actor: string): Promise<DeviceFormatStatus> {
    const dev = listDevices().find((d) => d.name === name);
    if (!dev) throw new HarborError('NOT_FOUND', `device ${name} not found`, { nextAction: 'Re-insert the drive and retry.' });
    if (!dev.removable) throw new HarborError('INVALID_REQUEST', `device ${name} is not removable media`, { nextAction: 'Harbor only formats removable drives; system disks are never touched.' });
    const holders = this.driveHolders(dev.mountpoint);
    if (holders.length) {
      throw new HarborError('INVALID_STATE', `${dev.mountpoint ?? dev.device} is in use by ${holders}`, { nextAction: 'Move the app data elsewhere or remove the app first; formatting erases everything on the drive.' });
    }
    const st = this.formatStatus(name);
    if (st && (st.state === 'requested' || st.state === 'formatting')) throw new HarborError('BUSY', `a format operation for ${name} is already running (${st.message})`);
    if (this.simulateRoot) {
      // Fake-hardware mode: no systemd, no real mkfs. Complete the oneshot
      // in-process after a beat so the UI's Formatting… spinner is exercised.
      // Mirror the mock API: the formatted drive lands at its label-derived
      // mountpoint (/mnt/<label>), not /mnt/<name>.
      this.writeFormatStatus(name, 'requested', `requested by ${actor}; starting the format`, null, dev.mountpoint);
      const slug = (dev.label ?? name).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || name;
      const mp = `/mnt/${slug}`;
      setTimeout(() => {
        this.writeFormatStatus(name, 'formatted', `formatted as ext4 and mounted at ${mp}`, 'ext4', mp);
        this.writeStatus(name, 'mounted', `mounted at ${mp}`, mp);
      }, 1200).unref?.();
      return { device: name, state: 'requested', message: 'format requested', fsType: null, mountpoint: dev.mountpoint, at: rfc3339(this.clock.now()) };
    }
    if (!this.mountStarter) throw new HarborError('UNSUPPORTED_CAPABILITY', 'device format is not available on this machine', { nextAction: `On the machine, run: sudo /opt/harbor/bin/harbor device-format ${name}` });
    this.writeFormatStatus(name, 'requested', `requested by ${actor}; starting the format`, null, dev.mountpoint);
    try {
      await this.mountStarter(`harbor-device-mount@${name}:format.service`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.writeFormatStatus(name, 'failed', `could not start the format: ${msg}`, null, dev.mountpoint);
      throw new HarborError('OPERATION_FAILED', `Harbor could not start the format (${msg})`, { nextAction: `On the machine, run: sudo /opt/harbor/bin/harbor device-format ${name}` });
    }
    return this.formatStatus(name) ?? { device: name, state: 'requested', message: 'format requested', fsType: null, mountpoint: dev.mountpoint, at: rfc3339(this.clock.now()) };
  }

  // Every app touching a mountpoint: bring-your-own folders (bind) plus whole
  // encrypted apps (volume role __home__). Shared by unmount and format so the
  // two refusals name the same apps.
  private driveHolders(mountpoint: string | null): string {
    const names = new Set<string>();
    for (const r of this.repo.resourcesByKind('bind')) {
      if (mountpoint && (r.name === mountpoint || r.name.startsWith(mountpoint + '/'))) names.add(this.repo.instance(r.instanceId)?.name ?? r.instanceId);
    }
    for (const r of this.repo.resourcesByKind('volume')) {
      if ((r.role === '__home__' || (r.metadata?.['homePath'] as string | undefined)) && mountpoint && (r.name === mountpoint || r.name.startsWith(mountpoint + '/'))) {
        names.add(this.repo.instance(r.instanceId)?.name ?? r.instanceId);
      }
    }
    return [...names].join(', ');
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
    // Refuse while an app holds a folder or a whole encrypted app on this
    // mount: yanking a live library corrupts writes.
    const holders = this.driveHolders(dev.mountpoint);
    if (holders) {
      throw new HarborError('INVALID_STATE', `${dev.mountpoint} is in use by ${holders}`, { nextAction: 'Move the app data elsewhere or remove the app first; Harbor never unmounts a drive out from under an app.' });
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

  private writeFormatStatus(name: string, state: DeviceFormatStatus['state'], message: string, fsType: string | null, mountpoint: string | null): void {
    if (!this.stateDir) return;
    try {
      const dir = path.join(this.stateDir, 'devices', name);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, 'format-status.json'), JSON.stringify({ device: name, state, message, fsType, mountpoint, at: rfc3339(this.clock.now()) }), { mode: 0o600 });
    } catch {
      /* status is best effort */
    }
  }
}
