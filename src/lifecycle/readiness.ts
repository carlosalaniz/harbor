import { request } from 'node:http';
import { sleep, type Clock } from '../util.js';

const MAX_BODY = 64 * 1024;

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

// One HTTP GET against the verified loopback binding. Own timeout, no redirects, bounded body.
export function probeOnce(hostPort: number, pathname: string, expected: number[], timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = request(
      { host: '127.0.0.1', port: hostPort, path: pathname, method: 'GET', headers: { host: `localhost:${hostPort}`, accept: '*/*', 'user-agent': 'harbor-readiness/1' }, timeout: timeoutMs },
      (res) => {
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_BODY) res.destroy();
        });
        res.on('end', () => done({ ok: expected.includes(res.statusCode ?? 0), status: res.statusCode ?? null, error: null }));
        res.on('close', () => done({ ok: expected.includes(res.statusCode ?? 0), status: res.statusCode ?? null, error: null }));
        res.on('error', (e) => done({ ok: false, status: res.statusCode ?? null, error: e.message }));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (e) => done({ ok: false, status: null, error: e.message }));
    req.end();
  });
}

export interface ReadinessSpec {
  hostPort: number;
  path: string;
  expectedStatus: number[];
  timeoutSeconds: number;
  deadlineSeconds: number;
}

// Retry every two seconds until the manifest deadline. Returns the last result.
export async function waitReady(spec: ReadinessSpec, clock: Clock, onAttempt?: (r: ProbeResult, attempt: number) => void, shouldAbort?: () => boolean): Promise<{ ok: boolean; attempts: number; last: ProbeResult }> {
  const deadline = clock.now().getTime() + spec.deadlineSeconds * 1000;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const last = await probeOnce(spec.hostPort, spec.path, spec.expectedStatus, spec.timeoutSeconds * 1000);
    onAttempt?.(last, attempts);
    if (last.ok) return { ok: true, attempts, last };
    if (shouldAbort?.()) return { ok: false, attempts, last };
    if (clock.now().getTime() + 2000 > deadline) return { ok: false, attempts, last };
    await sleep(2000);
  }
}
