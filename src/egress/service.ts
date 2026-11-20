// VPN and offline apps, daemon side (decision 184, docs/design/VPN.md §2 "Daemon side"): what each app's internet
// mode is, the host state that follows from it, the VPN page's model, and the "VPN is down" notification.
//
// The desired state is computed fresh from every instance each time (its effective mode, the subnet of its own
// network) and handed to root whole; applies are serialized and skipped when nothing changed since the last one
// this daemon run. A machine that never used a VPN or an offline app never starts the root step.
import path from 'node:path';
import { HarborError } from '../errors.js';
import type { Ctx } from '../lifecycle/context.js';
import type { InstanceRow } from '../state/repo.js';
import type { InternetMode, Manifest } from '../contracts/types.js';
import type { InternetDto, VpnDto } from '../contracts/api.js';
import { instanceDir, loadReleaseSnapshot, readInternetChoice } from '../lifecycle/instance-dir.js';
import { defaultNetworkName, identityFor } from '../planner/identity.js';
import { effectiveInternet, isAppSubnet, type EgressApp, type EgressState } from './rules.js';
import { packageInternet, packageRequiresVpn } from '../planner/internet.js';
import { parseWireguardConfig, tunnelSummary, type TunnelSummary } from './wireguard.js';
import type { EgressProvider, TunnelReport } from './provider.js';

export const VPN_SETTING = 'vpn';
export interface VpnSetting {
  allApps: boolean;
  tunnel: (TunnelSummary & { name: string | null; setAt: string }) | null;
  // the last apply covered something (apps or a tunnel): the next daemon start applies again even when it is empty
  applied: boolean;
}

// A tunnel with no handshake for this long is down (keepalive 25 s, rekey every 2 minutes).
export const HANDSHAKE_FRESH_S = 180;
// The read model (no root): no new received bytes for this long while an app uses the VPN = down.
export const RX_STALE_MS = 5 * 60_000;
const STATUS_CACHE_MS = 10_000;

export class EgressService {
  private lastApplied: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private defaults = new Map<string, { mode: InternetMode; requireVpn: boolean }>();
  private lastReport: { report: TunnelReport; at: number } | null = null;
  private lastError: { message: string; at: string } | null = null;
  private appliedAt: string | null = null;
  private rx: { bytes: number | null; changedAt: number } | null = null;

  constructor(
    private readonly ctx: Ctx,
    readonly provider: EgressProvider,
  ) {}

  setting(): VpnSetting {
    const s = this.ctx.repo.setting<Partial<VpnSetting>>(VPN_SETTING);
    return { allApps: s?.allApps === true, tunnel: s?.tunnel ?? null, applied: s?.applied === true };
  }
  private saveSetting(next: VpnSetting): void {
    this.ctx.repo.setSetting(VPN_SETTING, next);
  }

  // The package's own default (direct when it says nothing; vpn when it requires the VPN, decision 208) and whether
  // it requires the VPN, cached by instance + revision.
  packageNetwork(inst: InstanceRow, manifest?: Manifest): { mode: InternetMode; requireVpn: boolean } {
    if (manifest) return { mode: packageInternet(manifest), requireVpn: packageRequiresVpn(manifest) };
    const key = `${inst.id}@${inst.revision}`;
    const hit = this.defaults.get(key);
    if (hit) return hit;
    let net: { mode: InternetMode; requireVpn: boolean };
    try {
      const m = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'release'), inst.packageId).manifest;
      net = { mode: packageInternet(m), requireVpn: packageRequiresVpn(m) };
    } catch {
      // no readable release: the app cannot be started either; direct keeps it out of the rules
      return { mode: 'direct', requireVpn: false };
    }
    this.defaults.set(key, net);
    return net;
  }
  packageDefault(inst: InstanceRow, manifest?: Manifest): InternetMode {
    return this.packageNetwork(inst, manifest).mode;
  }

  choice(instanceId: string): InternetMode | null {
    return readInternetChoice(this.ctx.config.stateDir, instanceId);
  }

  modeOf(inst: InstanceRow, manifest?: Manifest): InternetMode {
    const net = this.packageNetwork(inst, manifest);
    return effectiveInternet(this.choice(inst.id), net.mode, this.setting().allApps, net.requireVpn);
  }

  internetDto(inst: InstanceRow): InternetDto {
    const net = this.packageNetwork(inst);
    const choice = this.choice(inst.id);
    const allApps = this.setting().allApps;
    return { mode: effectiveInternet(choice, net.mode, allApps, net.requireVpn), choice, packageDefault: net.mode, allApps, ...(net.requireVpn ? { requireVpn: true } : {}) };
  }

  // Every non-direct app whose network exists, with its subnets. `pending` = an app being installed or updated
  // whose manifest is not the stored one yet.
  async desired(pending?: { instanceId: string; manifest: Manifest }): Promise<EgressState> {
    const apps: EgressApp[] = [];
    for (const inst of this.ctx.repo.listInstances()) {
      const mode = this.modeOf(inst, pending?.instanceId === inst.id ? pending.manifest : undefined);
      if (mode === 'direct') continue;
      const net = await this.ctx.docker.inspectNetwork(defaultNetworkName(identityFor(this.ctx.installationId, inst.id)));
      if (!net) continue; // nothing can run without its network; the runner applies again once it exists
      if (!net.subnets.length) throw new HarborError('INVALID_STATE', `the network of ${inst.name} has no subnet Harbor can read`, { nextAction: 'Reinstall the app (Remove, then Reinstall) so Docker creates its network again.' });
      const bad = net.subnets.filter((s) => !isAppSubnet(s));
      if (bad.length) {
        throw new HarborError('INVALID_STATE', `the network of ${inst.name} uses ${bad.join(', ')}; ${mode === 'vpn' ? 'VPN' : 'offline'} apps need a private IPv4 network`, {
          nextAction: 'Set this app to Direct, or check Docker\'s default address pools (an IPv6 subnet on Harbor\'s app networks is not supported).',
        });
      }
      apps.push({ instanceId: inst.id, mode, subnets: [...net.subnets].sort() });
    }
    apps.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    return { format: 1, apps };
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // Bring the host in line with every app. Throws (fail closed) when root cannot; the caller's operation fails.
  sync(opts: { force?: boolean; pending?: { instanceId: string; manifest: Manifest } } = {}): Promise<void> {
    return this.serialize(async () => {
      const state = await this.desired(opts.pending);
      const json = JSON.stringify(state);
      const s = this.setting();
      if (!opts.force && json === this.lastApplied) return;
      if (!state.apps.length && !s.tunnel && !s.applied) {
        this.lastApplied = json; // nothing was ever set up on this machine: no root step at all
        return;
      }
      const avail = this.provider.available();
      if (!avail.ok) throw new HarborError('UNSUPPORTED_CAPABILITY', avail.reason ?? 'VPN and offline apps are not supported on this machine');
      try {
        const report = await this.provider.apply(state);
        this.lastReport = { report, at: Date.now() };
      } catch (e) {
        this.lastError = { message: e instanceof Error ? e.message : String(e), at: this.ctx.repo.now() };
        this.lastApplied = null;
        throw e;
      }
      this.lastApplied = json;
      this.lastError = null;
      this.appliedAt = this.ctx.repo.now();
      const applied = state.apps.length > 0 || s.tunnel !== null;
      if (applied !== s.applied) this.saveSetting({ ...this.setting(), applied });
    });
  }

  // Does this app need the rules before it starts (non-direct now, or the last applied state still names it)?
  needsSync(inst: InstanceRow, manifest?: Manifest): boolean {
    if (this.modeOf(inst, manifest) !== 'direct') return true;
    return this.lastApplied !== null && this.lastApplied.includes(`"${inst.id}"`);
  }

  // ---------------------------------------------------------------- the VPN itself

  async setTunnel(configText: string, name: string | null): Promise<VpnDto> {
    const cfg = parseWireguardConfig(configText); // refuses early, with the same words root would use
    const avail = this.provider.available();
    if (!avail.ok || !avail.tunnel) throw new HarborError('UNSUPPORTED_CAPABILITY', avail.reason ?? 'WireGuard is not available on this machine');
    await this.serialize(async () => {
      const report = await this.provider.setTunnel(configText);
      this.lastReport = { report, at: Date.now() };
      this.saveSetting({ ...this.setting(), tunnel: { ...tunnelSummary(cfg), name: name?.trim() ? name.trim().slice(0, 64) : null, setAt: this.ctx.repo.now() }, applied: true });
      this.rx = null;
      this.lastApplied = null; // the tunnel's DNS is part of the rules root loaded
    });
    await this.sync({ force: true });
    return this.vpn();
  }

  async removeTunnel(): Promise<VpnDto> {
    await this.serialize(async () => {
      const report = await this.provider.removeTunnel();
      this.lastReport = { report, at: Date.now() };
      this.saveSetting({ ...this.setting(), tunnel: null });
      this.rx = null;
      this.lastApplied = null;
    });
    this.ctx.notifier.resolve('vpn-down');
    await this.sync({ force: true });
    return this.vpn();
  }

  async setAllApps(enabled: boolean): Promise<VpnDto> {
    const before = this.setting();
    if (before.allApps === enabled) return this.vpn();
    const modesBefore = new Map(this.ctx.repo.listInstances().map((i) => [i.id, this.modeOf(i)]));
    this.saveSetting({ ...before, allApps: enabled });
    try {
      await this.sync();
    } catch (e) {
      // the switch is only on when the rules that make it true are loaded
      this.saveSetting({ ...this.setting(), allApps: before.allApps });
      throw e;
    }
    // The firewall moved them already; their containers still ask the resolver of their old mode (it is part of the
    // container), so each running app that changed is restarted in turn. A stopped one follows at its next start.
    for (const inst of this.ctx.repo.listInstances()) {
      if (inst.installState !== 'installed' || inst.desired !== 'running' || modesBefore.get(inst.id) === this.modeOf(inst)) continue;
      try {
        this.ctx.service.queueAction(inst.id, 'restart', 'vpn-policy', this.ctx.ids.uuid());
      } catch (e) {
        this.ctx.log.warn(`could not queue the restart of ${inst.name} after the every-app VPN switch: ${(e as Error).message}`);
      }
    }
    return this.vpn();
  }

  async check(): Promise<VpnDto> {
    this.lastReport = null;
    return this.vpn();
  }

  private async report(): Promise<TunnelReport | null> {
    if (!this.setting().tunnel) return this.lastReport?.report ?? null;
    if (this.lastReport && Date.now() - this.lastReport.at < STATUS_CACHE_MS) return this.lastReport.report;
    try {
      const report = await this.serialize(() => this.provider.status());
      this.lastReport = { report, at: Date.now() };
      return report;
    } catch {
      return this.lastReport?.report ?? null;
    }
  }

  tunnelState(report: TunnelReport | null, tunnel: VpnSetting['tunnel']): VpnDto['status']['state'] {
    if (!tunnel) return 'off';
    if (!report?.present) return 'down';
    const now = Date.now() / 1000;
    if (report.latestHandshake !== null && now - report.latestHandshake < HANDSHAKE_FRESH_S) return 'connected';
    if (report.latestHandshake === null && Date.parse(tunnel.setAt) > Date.now() - 60_000) return 'connecting';
    return 'down';
  }

  async vpn(): Promise<VpnDto> {
    const s = this.setting();
    const avail = this.provider.available();
    const report = await this.report();
    const apps: VpnDto['apps'] = [];
    // removed apps (data kept) run nothing: they are not listed (their choice comes back with Reinstall)
    for (const inst of this.ctx.repo.listInstances().filter((i) => i.installState !== 'retained')) {
      const mode = this.modeOf(inst);
      if (mode !== 'direct') apps.push({ instanceId: inst.id, name: inst.displayName ?? inst.name, mode });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name));
    return {
      available: avail.ok,
      tunnelAvailable: avail.ok && avail.tunnel,
      reason: avail.reason,
      tunnel: s.tunnel,
      status: {
        state: this.tunnelState(report, s.tunnel),
        latestHandshakeAt: report?.latestHandshake ? new Date(report.latestHandshake * 1000).toISOString() : null,
        rxBytes: report?.rxBytes ?? 0,
        txBytes: report?.txBytes ?? 0,
        checkedAt: this.lastReport ? new Date(this.lastReport.at).toISOString() : null,
      },
      allApps: s.allApps,
      apps,
      rules: { state: this.lastError ? 'failed' : this.appliedAt ? 'ok' : 'none', message: this.lastError?.message ?? null, appliedAt: this.appliedAt },
    };
  }

  // Observer tick (no root): while an app goes through the VPN, say so when the tunnel stops answering.
  observe(now = Date.now()): void {
    const s = this.setting();
    const users = this.ctx.repo.listInstances().filter((i) => i.installState === 'installed' && i.desired === 'running' && this.modeOf(i) === 'vpn');
    if (!users.length) {
      this.ctx.notifier.resolve('vpn-down');
      return;
    }
    const m = this.provider.readModel();
    let down = false;
    if (!s.tunnel || !m.present) down = true;
    else if (m.rxBytes !== null) {
      if (!this.rx || this.rx.bytes !== m.rxBytes) this.rx = { bytes: m.rxBytes, changedAt: now };
      down = now - this.rx.changedAt > RX_STALE_MS;
    }
    if (down) {
      const n = users.length;
      this.ctx.notifier.notify({
        kind: 'vpn-down',
        severity: 'warning',
        title: s.tunnel ? 'The VPN is not connected' : 'No VPN is set up',
        body: `${n === 1 ? `${users[0]!.displayName ?? users[0]!.name} goes` : `${n} apps go`} through the VPN and ${n === 1 ? 'has' : 'have'} no internet until it is back. Check Settings → VPN.`,
        dedupeKey: 'vpn-down',
      });
    } else this.ctx.notifier.resolve('vpn-down');
  }
}
