import { useEffect, useState } from 'react';
import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react';
import { subscribeUserNotifications, type UserNotification } from '../lib/userNotifications';

const AUTO_DISMISS_MS = 5_000;
const MAX_VISIBLE = 3;

export function NotificationCenter() {
  const [notifications, setNotifications] = useState<UserNotification[]>([]);

  useEffect(() => subscribeUserNotifications(
    (notification) => {
      setNotifications((current) => [
        notification,
        ...current.filter((item) => item.id !== notification.id),
      ].slice(0, MAX_VISIBLE));
      if (!notification.persistent) {
        window.setTimeout(() => {
          setNotifications((current) => current.filter((item) => item.id !== notification.id));
        }, AUTO_DISMISS_MS);
      }
    },
    (id) => setNotifications((current) => current.filter((item) => item.id !== id)),
  ), []);

  if (!notifications.length) return null;

  return (
    <aside aria-label="알림" className="pointer-events-none fixed bottom-5 right-5 z-[10000] flex w-[min(380px,calc(100vw-40px))] flex-col gap-2">
      {notifications.map((notification) => {
        const Icon = notification.kind === 'complete' ? CheckCircle : WarningCircle;
        const accent = notification.kind === 'complete' ? 'text-accent' : 'text-amber-600';
        return (
          <section key={notification.id} role={notification.kind === 'approval' ? 'alertdialog' : 'status'} className="pointer-events-auto rounded-xl border border-line bg-panel p-4 shadow-[0_14px_38px_rgba(23,33,29,0.24)]">
            <div className="flex items-start gap-3">
              <Icon aria-hidden size={22} weight="fill" className={`mt-0.5 shrink-0 ${accent}`} />
              <div className="min-w-0 flex-1">
                <h2 className="m-0 text-sm font-semibold text-text">{notification.title}</h2>
                <p className="mb-0 mt-1 line-clamp-3 text-xs leading-5 text-muted">{notification.message}</p>
                {notification.actionLabel ? (
                  <button type="button" className="mt-3 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-dim" onClick={() => {
                    window.focus();
                    document.querySelector<HTMLElement>('[role="dialog"] button')?.focus();
                  }}>
                    {notification.actionLabel}
                  </button>
                ) : null}
              </div>
              <button type="button" aria-label="알림 닫기" className="rounded p-1 text-muted hover:bg-panel-2 hover:text-text" onClick={() => setNotifications((current) => current.filter((item) => item.id !== notification.id))}>
                <X aria-hidden size={15} />
              </button>
            </div>
          </section>
        );
      })}
    </aside>
  );
}
