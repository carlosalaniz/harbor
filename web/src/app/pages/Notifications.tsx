import type { NotificationDto } from '../../../../src/contracts/api';
import { api } from '../../api';
import { Empty } from '../components';
import type { Console } from '../store';

// Full notifications screen (decision 114): every row, newest first. Each row can be marked read
// (click) or dismissed (×, deletes it); the header clears the badge (Mark all read) or the whole
// list (Dismiss all). Dismissing a row for a still-true condition re-creates it on the next tick.
export function Notifications({ c, onOpenApp }: { c: Console; onOpenApp: (instanceId: string) => void }) {
  const n = c.data.notifications;
  const items = n?.items ?? [];
  const unread = n?.unread ?? 0;
  const apply = (res: NonNullable<typeof n>) => c.patchData((d) => ({ ...d, notifications: res }));
  const markRead = (id: string) => api.markNotificationRead(id).then(apply).catch(() => {});
  const markAll = () => api.markAllNotificationsRead().then(apply).catch(() => {});
  const dismiss = (id: string) => api.dismissNotification(id).then(apply).catch(() => {});
  const dismissAll = () => api.dismissAllNotifications().then(apply).catch(() => {});
  const openItem = (item: NotificationDto) => {
    if (!item.read) void markRead(item.id);
    if (item.instanceId) onOpenApp(item.instanceId);
    else if (item.link) location.hash = item.link; // decision 122: where it is fixed
  };
  return (
    <section aria-labelledby="notif-h">
      <div className="row between">
        <div>
          <h2 id="notif-h">Notifications</h2>
          <p className="muted">Updates, warnings and failures. Dismissing deletes a row; a problem that still exists comes back on the next check.</p>
        </div>
        {items.length > 0 && (
          <span className="row" style={{ gap: 6 }}>
            {unread > 0 && (
              <button className="btn ghost small" onClick={() => void markAll()}>
                Mark all read
              </button>
            )}
            <button className="btn ghost small" onClick={() => void dismissAll()}>
              Dismiss all
            </button>
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <Empty title="Nothing yet" hint="Updates, warnings and failures appear here." />
      ) : (
        <ul className="plain bell-list notif-page-list">
          {items.map((item) => (
            <li key={item.id} className={item.read ? 'read' : 'unread'}>
              <div className="bell-row">
                <button className="bell-item" onClick={() => openItem(item)}>
                  <span className={`dot tone-${item.severity === 'error' ? 'bad' : item.severity === 'warning' ? 'warn' : 'ok'}`} aria-hidden="true" />
                  <span className="bell-text">
                    <strong>{item.title}</strong>
                    <span className="muted small">{item.body}</span>
                    <span className="muted small">{new Date(item.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  </span>
                </button>
                <button className="bell-dismiss always" aria-label={`Dismiss notification: ${item.title}`} title="Dismiss" onClick={() => void dismiss(item.id)}>
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
