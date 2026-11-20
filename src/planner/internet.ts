// Internet access in plans (decision 184). PURE: the plan's internet block, change lines and warnings for an
// install, a configure and an update; the runner stores `choice` and the host rules follow.
import type { InternetMode, Manifest } from '../contracts/types.js';
import type { PlanInternetDto } from '../contracts/api.js';
import { HarborError } from '../errors.js';
import { effectiveInternet, internetLabel } from '../egress/rules.js';

export interface InternetPlan {
  internet: PlanInternetDto;
  changes: string[];
  warnings: string[];
}

function warningsFor(name: string, to: InternetMode, vpnReady: boolean): string[] {
  return to === 'vpn' && !vpnReady ? [`No VPN is set up: ${name} has no internet until you add one in Settings → VPN.`] : [];
}

function why(choice: InternetMode | null, allApps: boolean, to: InternetMode): string {
  if (allApps && to === 'vpn' && choice !== 'vpn') return 'every app goes through the VPN';
  return choice === null ? 'the app\'s default' : 'your choice';
}

export function packageInternet(manifest: Pick<Manifest, 'network'>): InternetMode {
  return manifest.network?.internet ?? (manifest.network?.requireVpn ? 'vpn' : 'direct');
}

// Decision 208: the package says the app may only reach the internet through the VPN.
export function packageRequiresVpn(manifest: Pick<Manifest, 'network'>): boolean {
  return manifest.network?.requireVpn === true;
}

function refuseDirect(name: string): never {
  throw new HarborError('INVALID_REQUEST', `${name} may only reach the internet through the VPN; it cannot go direct`, { nextAction: 'Choose Through the VPN or Offline.' });
}

// Install: the operator may pick a mode in the review; picking the package's own default stores nothing, so the
// app keeps following it.
export function plannedInstallInternet(manifest: Pick<Manifest, 'network'>, name: string, requested: InternetMode | undefined, ctx: { allApps: boolean; vpnReady: boolean }): InternetPlan {
  const packageDefault = packageInternet(manifest);
  const required = packageRequiresVpn(manifest);
  if (required && requested === 'direct') refuseDirect(name);
  const choice = requested !== undefined && requested !== packageDefault ? requested : null;
  const to = effectiveInternet(choice, packageDefault, ctx.allApps, required);
  // decision 208: such an app is only installed once there is a VPN for it (offline needs none)
  if (required && to === 'vpn' && !ctx.vpnReady) {
    throw new HarborError('INVALID_REQUEST', `${name} only reaches the internet through a VPN, and none is set up`, { nextAction: 'Add your VPN in Settings → VPN first, then install it again.' });
  }
  return {
    internet: { from: null, to, choice, packageDefault, vpnReady: ctx.vpnReady },
    changes: to === 'direct' ? [] : [`Internet access: ${internetLabel(to)} (${why(choice, ctx.allApps, to)})${to === 'offline' ? '; it can be reached, but opens no connection to the internet, your network or other apps' : '; nothing it opens leaves this machine outside the tunnel'}`],
    warnings: warningsFor(name, to, ctx.vpnReady),
  };
}

// Configure: a mode, or 'default' to follow the package again. null = nothing changes.
// running: the app is meant to be running (it is re-created so its DNS lookups follow; a stopped app at its next start).
export function plannedConfigureInternet(packageDefault: InternetMode, current: InternetMode | null, requested: InternetMode | 'default', name: string, ctx: { allApps: boolean; vpnReady: boolean; running: boolean; requireVpn?: boolean }): InternetPlan | null {
  const choice = requested === 'default' ? null : requested;
  if (ctx.requireVpn && choice === 'direct') refuseDirect(name);
  if (choice === current) return null;
  const from = effectiveInternet(current, packageDefault, ctx.allApps, ctx.requireVpn);
  const to = effectiveInternet(choice, packageDefault, ctx.allApps, ctx.requireVpn);
  const label = (m: InternetMode) => internetLabel(m);
  const changes = [
    from === to
      ? `Internet access stays ${label(to)}${choice === null ? ' (it follows the app\'s default from now on)' : ctx.allApps && to === 'vpn' ? ' (every app goes through the VPN)' : ''}`
      : `Internet access: ${label(from)} → ${label(to)} (${why(choice, ctx.allApps, to)}). ${ctx.running ? `${name} restarts so its lookups follow too (same data, ports and addresses)` : `It applies when ${name} next starts`}`,
  ];
  return { internet: { from, to, choice, packageDefault, vpnReady: ctx.vpnReady }, changes, warnings: warningsFor(name, to, ctx.vpnReady) };
}

// Update: only an app that follows its package's default moves when the new release changes it.
export function plannedUpdateInternet(current: Pick<Manifest, 'network'>, next: Pick<Manifest, 'network'>, choice: InternetMode | null, name: string, ctx: { allApps: boolean; vpnReady: boolean }): InternetPlan | null {
  const before = packageInternet(current);
  const after = packageInternet(next);
  const reqBefore = packageRequiresVpn(current);
  const reqAfter = packageRequiresVpn(next);
  if (before === after && reqBefore === reqAfter) return null;
  const from = effectiveInternet(choice, before, ctx.allApps, reqBefore);
  const to = effectiveInternet(choice, after, ctx.allApps, reqAfter);
  if (from === to) return null;
  return {
    internet: { from, to, choice, packageDefault: after, vpnReady: ctx.vpnReady },
    changes: [`Internet access: ${internetLabel(from)} → ${internetLabel(to)}, the new release's default (you have not chosen one for this app; change it in its drawer)`],
    warnings: warningsFor(name, to, ctx.vpnReady),
  };
}
