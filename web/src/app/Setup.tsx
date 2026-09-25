import { useEffect, useState, type FormEvent } from 'react';
import type { SetupStatusDto } from '../../../src/contracts/api';
import { ApiError, api } from '../api';
import { WALLPAPERS, applyWallpaper, type Wallpaper } from './theme';
import { Mark } from './icons';
import { RecoveryCard } from './components';

// First run: this Harbor has no administrator yet. Three screens, Umbrel-style: name it, create the
// account (with the setup code from the installer), pick a look; then straight into the console, logged in.
export function SetupWizard({ status, onDone }: { status: SetupStatusDto; onDone: () => void }) {
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  // Shown once, on the screen between the account and the look.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState(status.deviceName ?? '');
  const [username, setUsername] = useState('admin');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallpaper, setWallpaper] = useState<Wallpaper>('harbor');
  useEffect(() => {
    document.title = 'Set up Harbor';
  }, []);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== again) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      const r = await api.setup({ code: code.replace(/\D/g, ''), username: username.trim(), password, ...(deviceName.trim() ? { deviceName: deviceName.trim() } : {}), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) });
      setRecoveryKey(r.recoveryKey);
      setStep(2);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}. ${err.nextAction}` : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="setup-wrap">
      <section className="card glass setup" aria-labelledby="setup-h">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <Mark size={22} />
          </span>
          <h1>Harbor</h1>
        </div>
        <ol className="setup-steps" aria-label="Steps">
          {['Name it', 'Your account', 'Recovery key', 'Your look'].map((label, i) => (
            <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
              {label}
            </li>
          ))}
        </ol>
        {step === 0 && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              setStep(1);
            }}
          >
            <h2 id="setup-h">Welcome. This is your own cloud.</h2>
            <p className="muted">
              Harbor {status.version} is running on <strong>{status.hostname}</strong>
              {status.lan.enabled && status.lan.url ? (
                <>
                  {' '}
                  and answers on your network at <code>{status.lan.url}</code>
                </>
              ) : null}
              . Give it a name people will recognise.
            </p>
            <label>
              Name
              <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder={`${status.hostname}`} maxLength={40} aria-label="Device name" autoFocus />
            </label>
            <div className="row end">
              <button className="btn primary" type="submit">
                Continue
              </button>
            </div>
          </form>
        )}
        {step === 1 && (
          <form className="stack" onSubmit={create}>
            <h2 id="setup-h">Create your account</h2>
            <p className="muted small">This is the only account on this Harbor. Choose a strong password; you can add two-factor login later in Settings.</p>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" pattern="[A-Za-z][A-Za-z0-9._-]{1,31}" required aria-label="Username" />
            </label>
            <label>
              What should Home call you? <span className="muted small">(optional — the greeting name, not the login)</span>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="nickname" maxLength={40} placeholder="Carlos" aria-label="Display name" />
            </label>
            <label>
              Password <span className="muted small">(at least 8 characters)</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required aria-label="Password" />
            </label>
            <label>
              Password again
              <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required aria-label="Password again" />
            </label>
            <label>
              Setup code <span className="muted small">(the 6 digits the installer printed on the machine)</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123 456" required aria-label="Setup code" autoComplete="one-time-code" />
            </label>
            <p className="muted small">
              Lost it? On the machine run <code>sudo /opt/harbor/bin/harbor setup-code --config /etc/harbor/harbor.json</code>.
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="row end">
              <button className="btn ghost" type="button" onClick={() => setStep(0)}>
                Back
              </button>
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create account'}
              </button>
            </div>
          </form>
        )}
        {step === 2 && (
          <div className="stack">
            <h2 id="setup-h">Your recovery key</h2>
            <p className="muted small">
              Harbor encrypts every app you install. These 12 words are the master key to all of them: they open your apps on a new machine even if this one
              is lost, stolen or wiped. Harbor stores them only behind your password, so this is the one time you will see them. Write them on paper and keep
              them somewhere safe, away from this machine.
            </p>
            {recoveryKey && <RecoveryCard words={recoveryKey} title="Your Harbor recovery key." note="It opens every app this Harbor encrypts, on any machine." onDismiss={() => setStep(3)} />}
          </div>
        )}
        {step === 3 && (
          <div className="stack">
            <h2 id="setup-h">Make it yours</h2>
            <p className="muted small">Pick a wallpaper (you can change it, or let Harbor rotate photos daily, in Settings → Appearance).</p>
            <ul className="wallpapers" role="listbox" aria-label="Wallpaper">
              {WALLPAPERS.filter((w) => w !== 'photo').map((w) => (
                <li key={w}>
                  <button
                    role="option"
                    aria-selected={wallpaper === w}
                    className={`swatch wp-${w} ${wallpaper === w ? 'active' : ''}`}
                    onClick={() => {
                      applyWallpaper(w);
                      setWallpaper(w);
                    }}
                    aria-label={`Wallpaper ${w}`}
                  >
                    <span className="swatch-name">{w.charAt(0).toUpperCase() + w.slice(1)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {status.tailscale.installed && !status.tailscale.loggedIn && <p className="muted small">Want to reach this Harbor from anywhere? Settings → Remote access connects it to your Tailscale network in two clicks.</p>}
            <div className="row end">
              <button className="btn primary" onClick={onDone} aria-label="Open Harbor">
                Open Harbor
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
