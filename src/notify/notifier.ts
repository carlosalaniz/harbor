import { createHmac } from 'node:crypto';
import type { NotificationRow, Repo } from '../state/repo.js';
import type { Logger } from '../lifecycle/context.js';
import type { Ids } from '../util.js';

// Notifications engine (decision 77). Producers call notify() from existing code paths;
// a persisting condition upserts one row (dedupe key), so the bell never fills with spam.
// External channels are fire-and-forget with one retry; a delivery failure becomes a
// console-only notification and never another delivery attempt (no loops).

export type Severity = 'info' | 'warning' | 'error';
const SEV_ORDER: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

export interface NtfyChannel {
  kind: 'ntfy';
  server: string; // e.g. https://ntfy.sh
  topic: string;
  token?: string;
  minSeverity?: Severity;
}
export interface WebhookChannel {
  kind: 'webhook';
  url: string;
  secret?: string; // when set: X-Harbor-Signature: sha256=<hmac of the body>
  minSeverity?: Severity;
}
export interface EmailChannel {
  kind: 'email';
  smtp: { host: string; port: number; secure: boolean; user?: string; pass?: string };
  from: string;
  to: string;
  minSeverity?: Severity;
}
export type Channel = NtfyChannel | WebhookChannel | EmailChannel;
export const CHANNELS_SETTING = 'notifications.channels';

export interface NotifyInput {
  kind: string;
  severity: Severity;
  title: string;
  body: string;
  instanceId?: string | null;
  dedupeKey: string;
}

// Transport seam: tests and fake mode inject a recorder; production uses fetch + a socket SMTP client.
export interface NotifyTransport {
  post(url: string, headers: Record<string, string>, body: string): Promise<{ ok: boolean; status: number | null; error: string | null }>;
  email(channel: EmailChannel, subject: string, text: string): Promise<{ ok: boolean; error: string | null }>;
}

export class Notifier {
  constructor(
    private readonly repo: Repo,
    private readonly ids: Ids,
    private readonly log: Logger,
    private readonly transport: NotifyTransport,
    private readonly deviceName: () => string,
  ) {}

  channels(): Channel[] {
    return this.repo.setting<Channel[]>(CHANNELS_SETTING) ?? [];
  }
  setChannels(channels: Channel[]): void {
    this.repo.setSetting(CHANNELS_SETTING, channels);
  }

  // Record (or refresh) a notification and deliver it externally when it is new.
  notify(n: NotifyInput): NotificationRow {
    const { created, row } = this.repo.upsertNotification({ id: this.ids.uuid(), ...n });
    if (created) {
      this.repo.pruneNotifications(500);
      void this.deliver(row).catch(() => {});
    }
    return row;
  }

  // A resolved condition disappears from the bell if nobody read it yet.
  resolve(dedupeKey: string): void {
    this.repo.deleteNotificationByKey(dedupeKey);
  }

  // Send one test notification to every configured channel; returns per-channel results (Settings "send a test").
  async test(): Promise<{ kind: string; ok: boolean; error: string | null }[]> {
    const out: { kind: string; ok: boolean; error: string | null }[] = [];
    for (const ch of this.channels()) {
      const r = await this.send(ch, { severity: 'info', title: `Test from ${this.deviceName()}`, body: 'Harbor notifications are configured correctly.' });
      out.push({ kind: ch.kind, ok: r.ok, error: r.error });
    }
    return out;
  }

  private async deliver(row: NotificationRow): Promise<void> {
    const channels = this.channels().filter((ch) => SEV_ORDER[row.severity] >= SEV_ORDER[ch.minSeverity ?? 'info']);
    if (!channels.length) return;
    let delivered = false;
    for (const ch of channels) {
      let r = await this.send(ch, row);
      if (!r.ok) r = await this.send(ch, row); // one retry
      if (r.ok) delivered = true;
      else {
        this.log.warn('notification delivery failed', { channel: ch.kind, error: r.error });
        // Console-only: a delivery failure must never try to deliver itself.
        this.repo.upsertNotification({ id: this.ids.uuid(), kind: 'delivery-failed', severity: 'warning', title: `Could not reach the ${ch.kind} channel`, body: r.error ?? 'unknown error', dedupeKey: `delivery-failed:${ch.kind}` });
      }
    }
    if (delivered) this.repo.markNotificationDelivered(row.id);
  }

  private async send(ch: Channel, msg: { severity: Severity; title: string; body: string }): Promise<{ ok: boolean; error: string | null }> {
    try {
      if (ch.kind === 'ntfy') {
        const headers: Record<string, string> = { title: msg.title, priority: msg.severity === 'error' ? 'high' : msg.severity === 'warning' ? 'default' : 'low', tags: 'anchor' };
        if (ch.token) headers['authorization'] = `Bearer ${ch.token}`;
        const r = await this.transport.post(`${ch.server.replace(/\/$/, '')}/${encodeURIComponent(ch.topic)}`, headers, msg.body);
        return { ok: r.ok, error: r.error ?? (r.ok ? null : `HTTP ${r.status}`) };
      }
      if (ch.kind === 'webhook') {
        const body = JSON.stringify({ device: this.deviceName(), severity: msg.severity, title: msg.title, body: msg.body, at: new Date().toISOString() });
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (ch.secret) headers['x-harbor-signature'] = `sha256=${createHmac('sha256', ch.secret).update(body).digest('hex')}`;
        const r = await this.transport.post(ch.url, headers, body);
        return { ok: r.ok, error: r.error ?? (r.ok ? null : `HTTP ${r.status}`) };
      }
      return await this.transport.email(ch, `[${this.deviceName()}] ${msg.title}`, msg.body);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

export function realTransport(): NotifyTransport {
  return {
    async post(url, headers, body) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
        return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, status: null, error: (e as Error).message };
      }
    },
    async email(channel, subject, text) {
      const { sendSmtp } = await import('./smtp.js');
      return sendSmtp(channel, subject, text);
    },
  };
}

export class FakeTransport implements NotifyTransport {
  posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  emails: { to: string; subject: string; text: string }[] = [];
  failPosts = false;
  async post(url: string, headers: Record<string, string>, body: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    this.posts.push({ url, headers, body });
    return this.failPosts ? { ok: false, status: 502, error: 'HTTP 502' } : { ok: true, status: 200, error: null };
  }
  async email(channel: EmailChannel, subject: string, text: string): Promise<{ ok: boolean; error: string | null }> {
    this.emails.push({ to: channel.to, subject, text });
    return { ok: true, error: null };
  }
}
