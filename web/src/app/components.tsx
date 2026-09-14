import { useEffect, useRef, type ReactNode } from 'react';
import type { CatalogItemDto, InstanceSummary, OperationDto } from '../../../src/contracts/api';
import { fmtTime, monogram, plainStatus } from './format';

export function AppIcon({ packageId, icon, name, size = 44 }: { packageId: string; icon: string | null; name: string; size?: number }) {
  const cls = size >= 64 ? 'appicon large' : size <= 28 ? 'appicon small' : 'appicon';
  if (icon) return <img className={cls} src={`/v1/catalog/${packageId}/asset/${icon}`} alt="" width={size} height={size} />;
  return (
    <span className={`${cls} monogram`} aria-hidden="true">
      {monogram(name)}
    </span>
  );
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted' | 'busy' | 'info'; children: ReactNode }) {
  return <span className={`pill tone-${tone}`}>{children}</span>;
}

export function StatusPill({ inst }: { inst: InstanceSummary }) {
  const s = plainStatus(inst);
  return (
    <Pill tone={s.tone}>
      <span className="dot" aria-hidden="true" />
      {s.label}
    </Pill>
  );
}

export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog ref={ref} className={`dialog ${wide ? 'wide' : ''}`} onClose={onClose} aria-labelledby="dlg-h">
      <div className="dialog-head">
        <h2 id="dlg-h">{title}</h2>
        <button className="btn ghost icon" onClick={onClose} aria-label="Close dialog">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {hint && <p className="muted">{hint}</p>}
      {action}
    </div>
  );
}

export function StoreCard({ item, onOpen, onInstall, disabled }: { item: CatalogItemDto; onOpen: () => void; onInstall: () => void; disabled: boolean }) {
  return (
    <li className="tile store">
      <button className="tile-main" onClick={onOpen} aria-label={`About ${item.name}`}>
        <AppIcon packageId={item.id} icon={item.presentation.icon} name={item.name} size={56} />
        <div>
          <h3>{item.name}</h3>
          <p className="muted small">{item.presentation.tagline ?? item.description}</p>
        </div>
      </button>
      {item.availability === 'unavailable' ? (
        <Pill tone="bad">Unavailable</Pill>
      ) : (
        <button className="btn primary" disabled={disabled} onClick={onInstall} aria-label={`Install ${item.name}`}>
          Install
        </button>
      )}
    </li>
  );
}

export function EventList({ events }: { events: OperationDto['events'] }) {
  return (
    <ol className="events">
      {events.slice(-8).map((e) => (
        <li key={e.cursor}>
          <span className="muted small">{fmtTime(e.at)}</span> <code>{e.phase}</code> {e.message}
        </li>
      ))}
    </ol>
  );
}

export function Copy({ text }: { text: string }) {
  return (
    <button
      className="btn ghost icon"
      aria-label={`Copy ${text}`}
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
      }}
    >
      ⧉
    </button>
  );
}
