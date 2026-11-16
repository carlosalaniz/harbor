import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeOnce } from '../../src/lifecycle/readiness.js';

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

describe('probeOnce', () => {
  // A reused keep-alive socket that the app closes as idle (gunicorn: 2 s, Harbor probes every 2 s) answers the
  // next probe with "socket hang up": every probe opens its own connection and asks the app to close it.
  it('never reuses a connection between probes', async () => {
    const seen: { connection: string | undefined; port: number | undefined }[] = [];
    server = createServer((req, res) => {
      seen.push({ connection: req.headers.connection, port: req.socket.remotePort });
      res.writeHead(302, { location: '/login' }).end();
    });
    server.keepAliveTimeout = 60_000;
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const a = await probeOnce(port, '/', [302], 2000);
    const b = await probeOnce(port, '/', [302], 2000);
    expect(a).toEqual({ ok: true, status: 302, error: null });
    expect(b.ok).toBe(true);
    expect(seen.map((s) => s.connection)).toEqual(['close', 'close']);
    expect(seen[0]!.port).not.toBe(seen[1]!.port);
  });
});
