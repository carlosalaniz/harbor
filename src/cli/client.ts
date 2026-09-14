import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ApiErrorBody } from '../contracts/api.js';
import { HarborError, type ErrorCode } from '../errors.js';
import { PRODUCT } from '../naming.js';

export function cliConfigDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  return process.env['HARBOR_CLI_CONFIG_DIR'] ?? path.join(xdg && xdg.length ? xdg : path.join(homedir(), '.config'), PRODUCT.codename);
}

interface CliState {
  url: string;
  token?: string;
  expiresAt?: string;
}

export function readCliState(): CliState | null {
  const file = path.join(cliConfigDir(), 'cli.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CliState;
  } catch {
    return null;
  }
}

export function writeCliState(state: CliState): void {
  const dir = cliConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'cli.json');
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function clearCliState(): void {
  const file = path.join(cliConfigDir(), 'cli.json');
  if (existsSync(file)) rmSync(file);
}

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    public token: string | null,
  ) {}

  private async call<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const h: Record<string, string> = { accept: 'application/json', ...headers };
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${url}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (e) {
      throw new HarborError('STATE_UNAVAILABLE', `cannot reach ${this.baseUrl}: ${(e as Error).cause ? String((e as Error).cause) : (e as Error).message}`, {
        nextAction: 'Is the Harbor daemon running? Check `systemctl status harbor` or your SSH port forward.',
      });
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (res.status >= 400) {
      const err = (parsed as ApiErrorBody | null)?.error;
      const opts: { nextAction?: string; details?: string[]; operationId?: string } = {};
      if (err?.nextAction) opts.nextAction = err.nextAction;
      if (err?.details) opts.details = err.details;
      if (err?.operationId) opts.operationId = err.operationId;
      throw new HarborError((err?.code as ErrorCode | undefined) ?? 'INTERNAL', err?.message ?? `HTTP ${res.status}`, opts);
    }
    return { status: res.status, body: parsed as T };
  }

  get<T>(url: string): Promise<T> {
    return this.call<T>('GET', url).then((r) => r.body);
  }
  post<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    return this.call<T>('POST', url, body, headers).then((r) => r.body);
  }
  delete(url: string): Promise<void> {
    return this.call<void>('DELETE', url).then(() => undefined);
  }
  async healthz(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/healthz`);
      return r.ok;
    } catch {
      return false;
    }
  }
}
