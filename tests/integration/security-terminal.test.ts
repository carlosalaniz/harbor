import { tailnetServeTarget } from '../../src/system/lan-https.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceLogsDto, LogsDto, SecurityDto, SystemDto, TotpSetupDto } from '../../src/contracts/api.js';
import { totpCode } from '../../src/auth/totp.js';
import { ADMIN, startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

describe('two-factor login', () => {
  it('setup → enable with a live code → login needs the code → replay refused → disable with the password', async () => {
    // A CLI/bootstrap enrollment mints no Harbor recovery key: the first
    // encrypted install issues one and shows it once (see app-homes).
    expect(await h.api.expect<SecurityDto>(200, 'GET', '/v1/account/security')).toEqual({ username: ADMIN.username, displayName: null, twoFactor: false, pending: false, recoveryKey: null });
    // The Home greeting name is separate from the login name: set it, clear it, validate it.
    expect(await h.api.expect<{ username: string; displayName: string | null }>(200, 'PUT', '/v1/account/name', { name: '  Carlos  ' })).toEqual({ username: ADMIN.username, displayName: 'Carlos' });
    expect((await h.api.expect<SecurityDto>(200, 'GET', '/v1/account/security')).displayName).toBe('Carlos');
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/account/name', { name: 'x'.repeat(41) });
    expect(await h.api.expect<{ username: string; displayName: string | null }>(200, 'PUT', '/v1/account/name', { name: '' })).toEqual({ username: ADMIN.username, displayName: null });
    expect((await h.api.expect<SecurityDto>(200, 'GET', '/v1/account/security')).displayName).toBeNull();
    await h.api.expect(200, 'PUT', '/v1/system/name', { name: '  Living room box ' });
    const setup = await h.api.expect<TotpSetupDto>(200, 'POST', '/v1/account/totp/setup', {});
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUrl).toContain('issuer=Harbor%20(Living%20room%20box)');
    expect((await h.api.expect<SecurityDto>(200, 'GET', '/v1/account/security')).pending).toBe(true);
    // still no second factor at login while pending
    await h.api.expect(201, 'POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password }, { authorization: '' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/account/totp/enable', { code: '000000' });
    const now = () => h.clock.now().getTime();
    await h.api.expect(204, 'POST', '/v1/account/totp/enable', { code: totpCode(setup.secret, now()) });
    expect(await h.api.expect<SecurityDto>(200, 'GET', '/v1/account/security')).toEqual({ username: ADMIN.username, displayName: null, twoFactor: true, pending: false, recoveryKey: null });
    // login: password alone → TOTP_REQUIRED (401); wrong code → UNAUTHENTICATED; right code → session
    await h.api.expectError(401, 'TOTP_REQUIRED', 'POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password }, { authorization: '' });
    await h.api.expectError(401, 'UNAUTHENTICATED', 'POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password, code: '000000' }, { authorization: '' });
    // wrong password with a right code still says invalid username or password (no factor leak)
    await h.api.expectError(401, 'UNAUTHENTICATED', 'POST', '/v1/sessions', { username: ADMIN.username, password: 'nope-nope-nope', code: totpCode(setup.secret, now()) }, { authorization: '' });
    h.clock.advance(60_000);
    const code = totpCode(setup.secret, now());
    const s = await h.api.expect<{ token: string }>(201, 'POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password, code }, { authorization: '' });
    expect(s.token).toBeTruthy();
    // the same code cannot be used twice
    await h.api.expectError(401, 'UNAUTHENTICATED', 'POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password, code }, { authorization: '' });
    // disable needs the password
    await h.api.expectError(401, 'UNAUTHENTICATED', 'POST', '/v1/account/totp/disable', { password: 'wrong-password-here' });
    await h.api.expect(204, 'POST', '/v1/account/totp/disable', { password: ADMIN.password });
    await h.api.expect(201, 'POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password }, { authorization: '' });
    const sys = await h.api.expect<SystemDto>(200, 'GET', '/v1/system');
    expect(sys.deviceName).toBe('Living room box');
    await h.api.expect(200, 'PUT', '/v1/system/name', { name: '' });
    expect((await h.api.expect<SystemDto>(200, 'GET', '/v1/system')).deviceName).toBeNull();
  });
});

describe('troubleshoot logs', () => {
  it('returns Harbor log lines and per-container app logs', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(r.op.state).toBe('succeeded');
    const logs = await h.api.expect<LogsDto>(200, 'GET', '/v1/logs/harbor?lines=50');
    expect(logs.source).toBe('memory');
    const app = await h.api.expect<InstanceLogsDto>(200, 'GET', `/v1/instances/${r.plan.instanceId}/logs?lines=20`);
    expect(app.containers.length).toBe(1);
    expect(app.containers[0]!.service).toBe('web');
    expect(app.containers[0]!.lines.join('\n')).toMatch(/created from excalidraw\/excalidraw@sha256/);
    await h.api.expectError(422, 'INVALID_REQUEST', 'GET', '/v1/logs/harbor?lines=5');
  });
});

describe('tailnet addresses survive a Tailscale logout/login', () => {
  it('the observer re-applies missing serve entries and follows a renamed node', async () => {
    const inst = (await h.api.instances()).find((i) => i.packageId === 'excalidraw')!;
    const r = await h.api.run({ kind: 'expose', instanceId: inst.id, via: 'tailnet' });
    expect(r.op.state).toBe('succeeded');
    const port = Number(new URL(r.plan.exposure!.url).port); // its own port (decision 133)
    const hostPort = inst.endpoints[0]!.hostPort;
    expect(h.tailscale.entries.some((e) => e.port === port)).toBe(true);
    // a logout wipes the serve config; the node comes back under a new name
    h.tailscale.entries = [];
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, dnsName: 'harbor-renamed.tail1234.ts.net' };
    const until = Date.now() + 8000;
    while (Date.now() < until && !h.tailscale.entries.some((e) => e.port === port)) await new Promise((r) => setTimeout(r, 200));
    expect(h.tailscale.entries.some((e) => e.port === port && e.target === tailnetServeTarget(hostPort))).toBe(true);
    const detail = await h.api.expect<{ events: { message: string }[]; endpoints: { urls: { tailnet?: string } }[] }>(200, 'GET', `/v1/instances/${inst.id}`);
    expect(detail.events.map((e) => e.message).join('\n')).toMatch(/tailnet address restored after Tailscale reconnected/);
    expect(detail.endpoints[0]!.urls.tailnet).toContain('harbor-renamed.tail1234.ts.net');
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, dnsName: 'harbor-test.tail1234.ts.net' };
  });
});

describe('terminal over WebSocket', () => {
  const connect = () => new WebSocket(h.baseUrl.replace(/^http/, 'ws') + '/v1/terminal', { headers: { host: new URL(h.baseUrl).host } } as unknown as string[]);
  it('refuses without a valid token, runs a shell for a valid session, relays output and exits cleanly', async () => {
    const bad = connect();
    const badMsg = await new Promise<string>((resolve) => {
      bad.addEventListener('open', () => bad.send(JSON.stringify({ type: 'auth', token: 'nope', cols: 80, rows: 24 })));
      bad.addEventListener('message', (e) => resolve(String(e.data)));
    });
    expect(JSON.parse(badMsg)).toMatchObject({ type: 'error' });
    await new Promise<void>((resolve) => (bad.readyState === bad.CLOSED ? resolve() : bad.addEventListener('close', () => resolve())));

    const ws = connect();
    const out: Buffer[] = [];
    const events: string[] = [];
    let ready: () => void = () => {};
    const readyP = new Promise<void>((r) => (ready = r));
    let exited: () => void = () => {};
    const exitP = new Promise<void>((r) => (exited = r));
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: h.token, cols: 100, rows: 30 })));
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data) as { type: string };
        events.push(m.type);
        if (m.type === 'ready') ready();
        if (m.type === 'exit') exited();
      } else out.push(Buffer.from(e.data as ArrayBuffer));
    });
    await readyP;
    expect(h.daemon.app.hasRoute({ method: 'GET', url: '/v1/terminal' })).toBe(true);
    ws.send(JSON.stringify({ type: 'input', data: 'echo harbor-term-$((6*7)); stty size\n' }));
    const deadline = Date.now() + 15_000;
    let text = '';
    // stty reports the pty size, but the shell may echo the command before the resize
    // lands; wait until BOTH the command output and the size line are present.
    while (Date.now() < deadline) {
      text = Buffer.concat(out).toString();
      if (text.includes('harbor-term-42') && /30 100/.test(text)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(text).toContain('harbor-term-42');
    expect(text).toMatch(/30 100/); // the pty took the requested size
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    ws.send(JSON.stringify({ type: 'input', data: 'exit\n' }));
    await exitP;
    expect(events).toEqual(['ready', 'exit']);
  });
});

// Decision 169: an open terminal closes when its session is revoked, not just when the shell exits.
describe('terminal ends with its session', () => {
  const login = async () => (await h.api.expect<{ token: string }>(201, 'POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password }, { authorization: '' })).token;
  const open = async (token: string) => {
    const ws = new WebSocket(h.baseUrl.replace(/^http/, 'ws') + '/v1/terminal', { headers: { host: new URL(h.baseUrl).host } } as unknown as string[]);
    const messages: { type: string; reason?: string }[] = [];
    let ready: () => void = () => {};
    const readyP = new Promise<void>((r) => (ready = r));
    const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 })));
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data) as { type: string; reason?: string };
      messages.push(m);
      if (m.type === 'ready') ready();
    });
    await readyP;
    return { ws, messages, closed };
  };
  const within = <T,>(p: Promise<T>, ms = 5000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('terminal stayed open')), ms))]);

  it('logout closes the terminal of that session at once', async () => {
    const token = await login();
    const t = await open(token);
    await h.api.expect(204, 'DELETE', '/v1/sessions/current', undefined, { authorization: `Bearer ${token}` });
    expect(await within(t.closed)).toBe(4401);
    expect(t.messages.find((m) => m.type === 'exit')?.reason).toMatch(/session ended/);
  });

  it('"log out other sessions" closes their terminals and keeps the caller\'s own', async () => {
    const other = await login();
    const mine = await login();
    const theirs = await open(other);
    const own = await open(mine);
    await h.api.expect(204, 'DELETE', '/v1/sessions/others', undefined, { authorization: `Bearer ${mine}` });
    expect(await within(theirs.closed)).toBe(4401);
    await new Promise((r) => setTimeout(r, 300));
    expect(own.ws.readyState).toBe(own.ws.OPEN);
    own.ws.close();
    await own.closed;
  });

  it('a password change closes the terminals of every other session', async () => {
    const mine = await login();
    const other = await login();
    const t = await open(other);
    const next = 'a-different-FIXTURE-password';
    await h.api.expect(200, 'PUT', '/v1/account/password', { currentPassword: ADMIN.password, newPassword: next }, { authorization: `Bearer ${mine}` });
    expect(await within(t.closed)).toBe(4401);
    await h.api.expect(200, 'PUT', '/v1/account/password', { currentPassword: next, newPassword: ADMIN.password }, { authorization: `Bearer ${mine}` });
  });
});
