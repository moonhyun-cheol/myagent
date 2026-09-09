import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_KEY = 'my-agent.appearance.v1';
const listeners = new Set<() => void>();
const valid = (value: string | null): ThemePreference => value === 'light' || value === 'dark' ? value : 'system';
function load(): ThemePreference {
  try { return valid(localStorage.getItem(THEME_KEY)); } catch { return 'system'; }
}
let preference = load();
const media = window.matchMedia('(prefers-color-scheme: dark)');
let snapshot = { preference, resolved: preference === 'system' ? (media.matches ? 'dark' : 'light') : preference };

function syncShellTheme(resolved: 'light' | 'dark') {
  const webview = (window as unknown as {
    chrome?: { webview?: { postMessage: (message: unknown) => void } };
  }).chrome?.webview;
  webview?.postMessage({ type: 'app.theme.set', preference, resolved });
}

function apply() {
  const resolved: 'light' | 'dark' = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  syncShellTheme(resolved);
  if (snapshot.preference === preference && snapshot.resolved === resolved) return;
  snapshot = { preference, resolved };
  listeners.forEach(listener => listener());
}

/** Call before React mounts, so native controls and the initial paint agree. */
export function initializeTheme() {
  apply();
}
media.addEventListener('change', apply);
window.addEventListener('storage', event => {
  if (event.key !== THEME_KEY && event.key !== null) return;
  preference = load();
  apply();
});

export function setThemePreference(value: ThemePreference): boolean {
  preference = valid(value);
  let saved = true;
  try { localStorage.setItem(THEME_KEY, preference); } catch { saved = false; }
  apply();
  return saved;
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useTheme() {
  return useSyncExternalStore(subscribe, () => snapshot);
}