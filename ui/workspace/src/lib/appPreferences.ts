export const MINIMIZE_TO_TRAY_STORAGE_KEY = 'myagent.minimize-to-tray-on-close';
export const UPDATE_AUTO_CHECK_STORAGE_KEY = 'myagent.update-auto-check';
export const UPDATE_POLL_INTERVAL_STORAGE_KEY = 'myagent.update-poll-interval-ms';
export const APP_PREFERENCES_CHANGED_EVENT = 'myagent:app-preferences-changed';

export const UPDATE_POLL_INTERVAL_OPTIONS = [
  { label: '1시간', ms: 60 * 60 * 1000 },
  { label: '30분', ms: 30 * 60 * 1000 },
  { label: '15분', ms: 15 * 60 * 1000 },
] as const;

type ShellWebViewHost = {
  postMessage: (message: unknown) => void;
};

function shellWebView(): ShellWebViewHost | null {
  const chrome = (window as unknown as { chrome?: { webview?: ShellWebViewHost } }).chrome;
  return chrome?.webview ?? null;
}

export function loadMinimizeToTrayOnClose(): boolean {
  const stored = window.localStorage.getItem(MINIMIZE_TO_TRAY_STORAGE_KEY);
  return stored === null ? true : stored !== 'false';
}

export function loadUpdateAutoCheckEnabled(): boolean {
  const stored = window.localStorage.getItem(UPDATE_AUTO_CHECK_STORAGE_KEY);
  return stored === null ? true : stored !== 'false';
}

export function loadUpdatePollIntervalMs(): number {
  const stored = Number(window.localStorage.getItem(UPDATE_POLL_INTERVAL_STORAGE_KEY));
  const fallback = UPDATE_POLL_INTERVAL_OPTIONS[0].ms;
  if (!Number.isFinite(stored)) return fallback;
  return UPDATE_POLL_INTERVAL_OPTIONS.some((option) => option.ms === stored) ? stored : fallback;
}

export function syncMinimizeToTrayOnClose(enabled = loadMinimizeToTrayOnClose()): void {
  shellWebView()?.postMessage({ type: 'app.closeBehavior.set', minimizeToTray: enabled });
}

export function syncUpdateSettings(
  enabled = loadUpdateAutoCheckEnabled(),
  pollIntervalMs = loadUpdatePollIntervalMs(),
): void {
  shellWebView()?.postMessage({
    type: 'app.update.settings',
    enabled,
    pollIntervalMs,
  });
}

export function saveMinimizeToTrayOnClose(enabled: boolean): void {
  window.localStorage.setItem(MINIMIZE_TO_TRAY_STORAGE_KEY, String(enabled));
  syncMinimizeToTrayOnClose(enabled);
  window.dispatchEvent(new CustomEvent(APP_PREFERENCES_CHANGED_EVENT));
}

export function saveUpdateAutoCheckEnabled(enabled: boolean): void {
  window.localStorage.setItem(UPDATE_AUTO_CHECK_STORAGE_KEY, String(enabled));
  syncUpdateSettings(enabled, loadUpdatePollIntervalMs());
  window.dispatchEvent(new CustomEvent(APP_PREFERENCES_CHANGED_EVENT));
}

export function saveUpdatePollIntervalMs(ms: number): void {
  window.localStorage.setItem(UPDATE_POLL_INTERVAL_STORAGE_KEY, String(ms));
  syncUpdateSettings(loadUpdateAutoCheckEnabled(), ms);
  window.dispatchEvent(new CustomEvent(APP_PREFERENCES_CHANGED_EVENT));
}

export function triggerUpdateCheckNow(): void {
  shellWebView()?.postMessage({ type: 'app.update.check' });
}
