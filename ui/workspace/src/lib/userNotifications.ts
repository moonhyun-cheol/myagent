export type UserNotificationKind = 'complete' | 'approval' | 'error';

export type UserNotification = {
  id: string;
  kind: UserNotificationKind;
  title: string;
  message: string;
  persistent: boolean;
  actionLabel?: string;
};

const EVENT_NAME = 'my-agent:user-notification';
const DISMISS_EVENT_NAME = 'my-agent:user-notification-dismiss';

function postNativeNotification(notification: UserNotification) {
  const webview = (window as typeof window & {
    chrome?: { webview?: { postMessage: (message: unknown) => void } };
  }).chrome?.webview;
  webview?.postMessage({
    type: 'app.notification.show',
    title: notification.title,
    message: notification.message,
    kind: notification.kind,
  });
}

export function showUserNotification(
  input: Omit<UserNotification, 'id'> & { id?: string; system?: 'always' | 'when-hidden' | 'never' },
): string {
  const notification: UserNotification = {
    ...input,
    id: input.id ?? `${input.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  window.dispatchEvent(new CustomEvent<UserNotification>(EVENT_NAME, { detail: notification }));

  const system = input.system ?? 'when-hidden';
  if (system === 'always' || (system === 'when-hidden' && document.visibilityState !== 'visible')) {
    postNativeNotification(notification);
  }
  return notification.id;
}

export function dismissUserNotification(id: string) {
  window.dispatchEvent(new CustomEvent<string>(DISMISS_EVENT_NAME, { detail: id }));
}

export function subscribeUserNotifications(
  onShow: (notification: UserNotification) => void,
  onDismiss: (id: string) => void,
): () => void {
  const show = (event: Event) => onShow((event as CustomEvent<UserNotification>).detail);
  const dismiss = (event: Event) => onDismiss((event as CustomEvent<string>).detail);
  window.addEventListener(EVENT_NAME, show);
  window.addEventListener(DISMISS_EVENT_NAME, dismiss);
  return () => {
    window.removeEventListener(EVENT_NAME, show);
    window.removeEventListener(DISMISS_EVENT_NAME, dismiss);
  };
}
