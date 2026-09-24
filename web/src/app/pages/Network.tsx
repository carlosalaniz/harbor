// Settings → Network: the LAN HTTPS card + the trust sheet (decision 109).
//
// The card is the whole trick the request asks for: a toggle, the secure
// address once it is on, and whether THIS browser already trusts the cert —
// probed live (fetch the HTTPS console; a trusted browser handshakes, an
// untrusted one fails it), so the operator knows if they are done.
//
// The sheet is one primary Download button (the CA cert, served openly from
// plain HTTP) plus per-platform numbered steps. iOS is two stages on purpose
// (install the profile, THEN enable full trust — the step everyone misses).
// Firefox ignores the system store on every platform, so it gets its own note
// everywhere.
import { useCallback, useEffect, useState } from 'react';
import type { NetworkHttpsDto } from '../../../../src/contracts/api';
import { ApiError, api } from '../../api';
import { Copy, Dialog, Pill } from '../components';
import type { Console } from '../store';

type Trust = 'checking' | 'trusted' | 'untrusted' | 'unreachable' | 'unknown';

const PLATFORMS = ['macOS', 'iOS', 'Windows', 'Android', 'Linux'] as const;
type Platform = (typeof PLATFORMS)[number];

function trustLabel(t: Trust): { tone: 'ok' | 'warn' | 'muted' | 'busy'; text: string } {
  switch (t) {
    case 'trusted':
      return { tone: 'ok', text: 'This browser trusts the certificate' };
    case 'untrusted':
      return { tone: 'warn', text: 'This browser does not trust it yet' };
    case 'checking':
      return { tone: 'busy', text: 'Checking this browser…' };
    case 'unreachable':
      return { tone: 'muted', text: 'Could not reach the secure address from here' };
    default:
      return { tone: 'muted', text: 'Trust unknown' };
  }
}

export function Network({ c }: { c: Console }) {
  const [st, setSt] = useState<NetworkHttpsDto | null>(c.data.system?.network.https ?? null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [trust, setTrust] = useState<Trust>('unknown');
  const [sheet, setSheet] = useState(false);
  const lanOn = c.data.system?.lan.enabled ?? false;
  const lanUrl = c.data.system?.lan.url ?? null;

  const load = useCallback(() => api.networkHttps().then(setSt, () => setSt(null)), []);
  useEffect(() => {
    void load();
  }, [load]);
  // Keep the card honest while polling: the system DTO carries the same shape.
  useEffect(() => {
    const sys = c.data.system?.network.https;
    if (sys) setSt(sys);
  }, [c.data.system]);

  // The trust probe runs when the card is on: fetch the secure console URL
  // and see if THIS browser completes the handshake. From the plain-HTTP
  // console this is allowed (https fetch from an http page); from an https
  // page it is same-origin. Either way a TypeError means "untrusted".
  useEffect(() => {
    if (!st?.enabled || !st.url) {
      setTrust('unknown');
      return;
    }
    let live = true;
    setTrust('checking');
    void api
      .probeHttpsTrust(st.url)
      .then((r) => {
        if (live) setTrust(r);
      })
      .catch(() => {
        if (live) setTrust('unknown');
      });
    return () => {
      live = false;
    };
  }, [st?.enabled, st?.url]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const next = await api.setNetworkHttps(on);
      setSt(next);
      await c.refresh();
    } catch (e) {
      setMsg(e instanceof ApiError ? `${e.message}. ${e.nextAction}` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const t = trustLabel(trust);
  return (
    <>
      <section className="card" aria-labelledby="net-https-h">
        <div className="row between wrap">
          <div>
            <h2 id="net-https-h">Secure addresses</h2>
            <p className="muted small">Open Harbor and your apps over HTTPS on your home network, with no warning, after you trust one certificate per device. Nothing leaves your network; Harbor mints the certificate itself.</p>
          </div>
          <label className="row">
            <input type="checkbox" checked={st?.enabled ?? false} disabled={busy || (!st?.enabled && !lanOn)} onChange={(e) => void toggle(e.target.checked)} aria-label="Secure addresses on the home network" />
            <span className="small">{st?.enabled ? 'On' : 'Off'}</span>
          </label>
        </div>
        {!lanOn && !st?.enabled && <p className="warn small">LAN mode is off, so there are no network addresses to secure. Turn on LAN mode first (bootstrap --lan on the machine).</p>}
        {st?.enabled && st.url && (
          <dl className="kv">
            <dt>Secure address</dt>
            <dd>
              <a href={st.url} target="_blank" rel="noopener noreferrer">
                {st.url}
              </a>{' '}
              <Copy text={st.url} />
            </dd>
            <dt>This browser</dt>
            <dd>
              <Pill tone={t.tone}>
                <span className="dot" aria-hidden="true" />
                {t.text}
              </Pill>{' '}
              {trust === 'trusted' ? (
                <button className="btn ghost small" onClick={() => st.url && void api.probeHttpsTrust(st.url).then(setTrust)}>
                  Re-check
                </button>
              ) : trust === 'untrusted' ? (
                <button className="btn small" onClick={() => setSheet(true)}>
                  Trust it on this device…
                </button>
              ) : null}
            </dd>
            {st.fingerprint && (
              <>
                <dt>Certificate</dt>
                <dd className="small">
                  <code className="secret">{st.fingerprint}</code> <Copy text={st.fingerprint} />
                  {st.expiresAt && <span className="muted"> · valid until {new Date(st.expiresAt).toLocaleDateString()}</span>}
                </dd>
              </>
            )}
          </dl>
        )}
        {st?.enabled && (
          <div className="row wrap">
            <button className="btn" onClick={() => setSheet(true)}>
              How to trust it on a new device…
            </button>
          </div>
        )}
        {!st?.enabled && lanUrl && <p className="muted small">Plain addresses stay as they are: {lanUrl} (this console) plus one HTTP address per app.</p>}
        {msg && (
          <p className="error small" role="alert">
            {msg}
          </p>
        )}
      </section>
      {sheet && st && <TrustSheet state={st} onClose={() => setSheet(false)} />}
    </>
  );
}

function TrustSheet({ state, onClose }: { state: NetworkHttpsDto; onClose: () => void }) {
  const [platform, setPlatform] = useState<Platform>('macOS');
  const caUrl = '/v1/network/https/ca.crt';
  return (
    <Dialog title="Trust Harbor on this device" onClose={onClose}>
      <p>
        Download the certificate, install it for <strong>{platform}</strong> below, then open{' '}
        <a href={state.url ?? 'https://harbor.local/'} target="_blank" rel="noopener noreferrer">
          {state.url ?? 'https://harbor.local/'}
        </a>{' '}
        with no warning. One trust per device covers Harbor and every app.
      </p>
      <p>
        <a className="btn primary" href={caUrl} download="harbor-local-ca.crt">
          Download certificate
        </a>{' '}
        <span className="muted small">harbor-local-ca.crt · keep it; you need it once per device.</span>
      </p>
      {state.fingerprint && (
        <p className="muted small">
          Compare this fingerprint on the device before trusting: <code className="secret">{state.fingerprint}</code> <Copy text={state.fingerprint} />
        </p>
      )}
      <div className="row wrap" role="tablist" aria-label="Device type">
        {PLATFORMS.map((p) => (
          <button key={p} role="tab" aria-selected={platform === p} className={`btn ghost small ${platform === p ? 'active' : ''}`} onClick={() => setPlatform(p)}>
            {p}
          </button>
        ))}
      </div>
      <ol className="steps">{stepsFor(platform).map((s, i) => <li key={i}>{s}</li>)}</ol>
      <p className="muted small">Firefox keeps its own certificate store on every platform: Preferences → Privacy &amp; Security → Certificates → View Certificates → Authorities → Import, tick “Trust this CA to identify websites”, then restart Firefox.</p>
    </Dialog>
  );
}

function stepsFor(p: Platform): string[] {
  switch (p) {
    case 'macOS':
      return [
        'Open the downloaded harbor-local-ca.crt — Keychain Access opens with an import dialog. Add it to the login keychain.',
        'In Keychain Access, find “Harbor Local CA”, open it, expand Trust, and set “When using this certificate” to Always Trust. Close the window (your password confirms).',
        'Reload https://harbor.local/ — the padlock is there with no warning.',
      ];
    case 'iOS':
      return [
        'Stage 1 — install the profile: open this page in Safari, tap Download certificate, then go to Settings → General → VPN & Device Management, tap the Harbor profile, and Install it (your passcode confirms).',
        'Stage 2 — enable full trust (the step everyone misses): go to Settings → General → About → Certificate Trust Settings and turn ON full trust for “Harbor Local CA”.',
        'Open https://harbor.local/ in Safari — no warning. (Other browsers on iOS use the same store once full trust is on.)',
      ];
    case 'Windows':
      return [
        'Double-click harbor-local-ca.crt → Install Certificate → Local Machine (admin confirms) → “Place all certificates in the following store” → Trusted Root Certification Authorities → Finish.',
        'Close every browser window completely, then reopen https://harbor.local/ — the padlock is there.',
      ];
    case 'Android':
      return [
        'Open Settings → Security → More security settings → Install a certificate → CA certificate (the exact path varies by maker; Samsung: Biometrics and security → Other security settings).',
        'Pick the downloaded harbor-local-ca.crt, confirm the warning (Android warns about any user CA — that is normal), and name it Harbor.',
        'Open https://harbor.local/ in Chrome — no warning.',
      ];
    case 'Linux':
      return [
        'Copy harbor-local-ca.crt to /usr/local/share/ca-certificates/harbor-local-ca.crt (sudo), then run sudo update-ca-certificates.',
        'Restart the browser completely (Chrome/Edge read the system store on startup; Firefox needs its own import below).',
        'Open https://harbor.local/ — the padlock is there.',
      ];
  }
}
