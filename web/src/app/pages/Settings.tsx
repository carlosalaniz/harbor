import type { Console } from '../store';

export function Settings({ c, onLogout }: { c: Console; onLogout: () => void }) {
  const port = c.data.system ? new URL(c.data.system.managementOrigin).port : '18000';
  const appPorts = [...new Set(c.data.instances.flatMap((i) => i.endpoints.map((e) => e.hostPort)))].sort();
  const forwards = [Number(port), ...appPorts, 9090, 9443].map((p) => `-L ${p}:127.0.0.1:${p}`).join(' ');
  return (
    <>
      <section className="card" aria-labelledby="acc-h">
        <h2 id="acc-h">Session</h2>
        <p className="muted small">Your login token lives in this tab's memory only. Reloading requires logging in again; running operations continue on the server.</p>
        <button className="btn" onClick={onLogout}>
          Log out
        </button>
      </section>
      <section className="card" aria-labelledby="access-h">
        <h2 id="access-h">Access from another machine</h2>
        <p className="muted small">Harbor and its apps listen on 127.0.0.1 only. Forward the same port numbers over SSH, or publish apps on your tailnet from the Publishing page.</p>
        <pre className="code">ssh {forwards} user@this-host</pre>
        <p className="muted small">If a local port is busy on your machine, pick another local port for that entry (for example <code>-L 28080:127.0.0.1:18080</code>) and open it at that local port.</p>
      </section>
      <section className="card" aria-labelledby="about-h">
        <h2 id="about-h">About</h2>
        <dl className="kv">
          <dt>Version</dt>
          <dd>{c.data.system?.version ?? '—'}</dd>
          <dt>Profile</dt>
          <dd>{c.data.system?.profile ?? '—'}</dd>
          <dt>Installation</dt>
          <dd>
            <code>{c.data.system?.installationId ?? '—'}</code>
          </dd>
          <dt>Trust boundary</dt>
          <dd>The Harbor service account has Docker (root-equivalent) authority. The console is not a sandbox against anyone with root or Docker access on this host.</dd>
        </dl>
      </section>
    </>
  );
}
