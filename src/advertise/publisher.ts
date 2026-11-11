// Decision 200: the I/O half of LAN announcements. One `avahi-publish` child per announced endpoint, talking to
// avahi over D-Bus as the harbor user (avahi's D-Bus policy lets any user publish; checked live on Ubuntu 24.04
// under harbor.service's sandbox). Nothing is written to /etc: the children die with the daemon
// (KillMode=control-group), and avahi withdraws a service the moment its client goes away, so a crash leaves
// nothing behind to clean up.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { publishArgs, type Advert } from './adverts.js';

export const AVAHI_PUBLISH_BIN = '/usr/bin/avahi-publish';
// a child that exited on its own is started again after this long (a name taken by a service file of the
// operator's own, avahi gone for good); the observer's next tick does the retry
export const RETRY_MS = 30_000;

export interface PublishedState {
  state: 'announced' | 'starting' | 'failed';
  name: string | null; // the name avahi confirmed ("Established under name …")
  error: string | null;
}

export interface AdvertPublisher {
  available(): boolean;
  // make the running set equal to `adverts` (same key and arguments: left alone)
  apply(adverts: Advert[]): void;
  state(key: string): PublishedState | null;
  close(): Promise<void>;
}

interface Entry {
  sig: string;
  advert: Advert;
  child: ChildProcess | null;
  stopping: boolean;
  state: PublishedState;
  retryAt: number;
}

type Spawn = (bin: string, args: string[]) => ChildProcess;

export class ProcessAdvertPublisher implements AdvertPublisher {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
    private readonly bin = AVAHI_PUBLISH_BIN,
    private readonly spawnFn: Spawn = (bin, args) => spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
    private readonly now: () => number = Date.now,
  ) {}

  available(): boolean {
    return existsSync(this.bin);
  }

  apply(adverts: Advert[]): void {
    const wanted = new Map(adverts.map((a) => [a.key, a]));
    for (const [key, e] of this.entries) {
      const a = wanted.get(key);
      if (!a || JSON.stringify(publishArgs(a)) !== e.sig) {
        this.stop(e);
        this.entries.delete(key);
      }
    }
    for (const a of adverts) {
      const e = this.entries.get(a.key);
      if (e && (e.child || this.now() < e.retryAt)) continue;
      this.start(a, e);
    }
  }

  state(key: string): PublishedState | null {
    return this.entries.get(key)?.state ?? null;
  }

  async close(): Promise<void> {
    const exits: Promise<void>[] = [];
    for (const e of this.entries.values()) {
      const c = e.child;
      if (c && c.exitCode === null && c.signalCode === null) exits.push(new Promise<void>((r) => c.once('exit', () => r())));
      this.stop(e);
    }
    this.entries.clear();
    await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 2000))]);
  }

  private stop(e: Entry): void {
    e.stopping = true;
    if (e.child && e.child.exitCode === null) e.child.kill('SIGTERM');
    e.child = null;
  }

  private start(a: Advert, prev: Entry | undefined): void {
    const args = publishArgs(a);
    const e: Entry = prev ?? { sig: JSON.stringify(args), advert: a, child: null, stopping: false, state: { state: 'starting', name: null, error: null }, retryAt: 0 };
    e.stopping = false;
    e.state = { state: 'starting', name: null, error: prev?.state.error ?? null };
    this.entries.set(a.key, e);
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.bin, args);
    } catch (err) {
      this.failed(e, err instanceof Error ? err.message : String(err));
      return;
    }
    e.child = child;
    let lastErr = '';
    // avahi-publish writes everything, "Established under name …" included, to stderr (checked live, avahi 0.8);
    // stdout is read the same way in case another build differs
    const onText = (d: string) => {
      for (const raw of d.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const m = /^Established under name '(.*)'$/.exec(line);
        if (m) {
          if (e.child === child) {
            e.state = { state: 'announced', name: m[1] ?? a.name, error: null };
            this.log.info(`announced ${a.type} "${m[1]}" on port ${a.port} on the network`);
          }
        } else lastErr = line;
      }
    };
    child.stdout?.setEncoding('utf8').on('data', onText);
    child.stderr?.setEncoding('utf8').on('data', onText);
    child.on('error', (err) => {
      if (e.child === child) this.failed(e, err.message);
    });
    child.on('exit', (code, signal) => {
      if (e.child !== child || e.stopping) return;
      this.failed(e, lastErr || `avahi-publish exited (${signal ?? code})`);
    });
  }

  private failed(e: Entry, message: string): void {
    // logged when the reason changes, not on every retry
    if (e.state.error !== message) this.log.warn(`announcing ${e.advert.type} "${e.advert.name}" failed: ${message}; Harbor tries again every ${RETRY_MS / 1000} s`);
    e.child = null;
    e.retryAt = this.now() + RETRY_MS;
    e.state = { state: 'failed', name: null, error: message };
  }
}

// Fake mode, tests and dev: keeps what would be announced.
export class FakeAdvertPublisher implements AdvertPublisher {
  readonly current = new Map<string, Advert>();
  available(): boolean {
    return true;
  }
  apply(adverts: Advert[]): void {
    this.current.clear();
    for (const a of adverts) this.current.set(a.key, a);
  }
  state(key: string): PublishedState | null {
    const a = this.current.get(key);
    return a ? { state: 'announced', name: a.name, error: null } : null;
  }
  async close(): Promise<void> {
    this.current.clear();
  }
}
