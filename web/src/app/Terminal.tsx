import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { isMockUi } from '../mock/api';

// A shell on the machine (Settings → Advanced access). WebSocket to the daemon; the first message carries the
// session token, then keystrokes go up as JSON and terminal bytes come down as binary frames.
export function Terminal({ onStatus }: { onStatus?: (s: 'connecting' | 'open' | 'closed', note?: string) => void }) {
  // Design mode has no daemon and no socket: say so instead of spinning on a dead WebSocket.
  if (isMockUi()) {
    return (
      <div className="terminal-wrap">
        <div className="terminal" role="application" aria-label="Terminal (unavailable in design mode)">
          <p className="muted small" style={{ padding: 12 }}>
            The terminal needs a running daemon. Run <code>pnpm dev</code> for the live console; this design mode is fixtures only.
          </p>
        </div>
      </div>
    );
  }
  const host = useRef<HTMLDivElement>(null);
  const [gen, setGen] = useState(0);
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new XTerm({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', theme: { background: '#0b1016', foreground: '#e6edf3', cursor: '#3d9cff', selectionBackground: 'rgba(61,156,255,0.35)' }, scrollback: 5000, allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/v1/terminal`);
    ws.binaryType = 'arraybuffer';
    let opened = false;
    const status = (s: 'connecting' | 'open' | 'closed', n?: string) => {
      setState(s);
      setNote(n ?? null);
      onStatus?.(s, n);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: api.currentToken(), cols: term.cols, rows: term.rows }));
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data) as { type: string; message?: string; reason?: string };
        if (m.type === 'ready') {
          opened = true;
          status('open');
          term.focus();
        } else if (m.type === 'exit') status('closed', m.reason ?? 'the shell exited');
        else if (m.type === 'error') status('closed', m.message ?? 'terminal unavailable');
      } else term.write(new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onclose = () => status('closed', opened ? undefined : 'connection closed');
    ws.onerror = () => status('closed', 'connection error');
    const inDisp = term.onData((d) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'input', data: d })));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {
        /* hidden */
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      inDisp.dispose();
      ws.close();
      term.dispose();
    };
  }, [gen, onStatus]);
  return (
    <div className="terminal-wrap">
      <div ref={host} className="terminal" role="application" aria-label="Terminal" />
      <div className="row between wrap terminal-bar">
        <span className="muted small">
          {state === 'connecting' ? 'Connecting…' : state === 'open' ? 'Connected · shell of the harbor service account on this machine' : `Closed${note ? ` · ${note}` : ''}`}
        </span>
        {state === 'closed' && (
          <button className="btn" onClick={() => setGen((g) => g + 1)}>
            New session
          </button>
        )}
      </div>
    </div>
  );
}
