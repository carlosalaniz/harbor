import { createServer } from 'node:net';

// Real loopback bind probe. On Linux (and macOS) a wildcard/dual-stack listener on the same
// port makes this bind fail with EADDRINUSE, so the probe also covers 0.0.0.0/:: overlap.
export async function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

export interface PortObserver {
  free(port: number): Promise<boolean>;
}

export const realPortObserver: PortObserver = { free: loopbackPortFree };
