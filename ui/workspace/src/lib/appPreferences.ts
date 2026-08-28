export const MINIMIZE_TO_TRAY_STORAGE_KEY = 'myagent.minimize-to-tray-on-close';
export const APP_PREFERENCES_CHANGED_EVENT = 'myagent:app-preferences-changed';

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

export function syncMinimizeToTrayOnClose(enabled = loadMinimizeToTrayOnClose()): void {
  shellWebView()?.postMessage({ type: 'app.closeBehavior.set', minimizeToTray: enabled });
}

export function saveMinimizeToTrayOnClose(enabled: boolean): void {
  window.localStorage.setItem(MINIMIZE_TO_TRAY_STORAGE_KEY, String(enabled));
  syncMinimizeToTrayOnClose(enabled);
  window.dispatchEvent(new CustomEvent(APP_PREFERENCES_CHANGED_EVENT));
}
