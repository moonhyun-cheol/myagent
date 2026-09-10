/** Bridge Preview/Chat → WPF shell BrowserWebView (real web access). */

type ChromeWebViewHost = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
};

export type InAppBrowserTab = {
  id: string;
  url: string;
  title: string;
  active: boolean;
  loading: boolean;
  primary: boolean;
  controlled: boolean;
  observing: boolean;
};

export type InAppBrowserState = {
  visible: boolean;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  status: string;
  activeTabId: string;
  returnTabId: string | null;
  tabs: InAppBrowserTab[];
};

function shellWebView(): ChromeWebViewHost | null {
  const chrome = (window as unknown as { chrome?: { webview?: ChromeWebViewHost } }).chrome;
  return chrome?.webview ?? null;
}

export function isShellInAppBrowserAvailable(): boolean {
  return shellWebView() !== null;
}

export function closeInAppBrowser(): void {
  shellWebView()?.postMessage({ type: 'inAppBrowser.close' });
}

export function createInAppBrowserTab(): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.tab.create' });
  return true;
}

export function closeInAppBrowserTab(tabId: string): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.tab.close', tabId });
  return true;
}

export function activateInAppBrowserTab(tabId: string): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.tab.activate', tabId });
  return true;
}

export function openInAppBrowserDevTools(tabId: string): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.devtools', tabId });
  return true;
}

export function takeOverInAppBrowserTab(tabId: string): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.tab.takeOver', tabId });
  return true;
}

export function returnFromObservedBrowserTab(): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.tab.return' });
  return true;
}

export function promoteInAppBrowserTab(url: string): boolean {
  const webview = shellWebView();
  if (!webview || !/^https?:\/\//i.test(url)) return false;
  webview.postMessage({ type: 'inAppBrowser.tab.promote', url });
  return true;
}

export function listInAppBrowserTabs(): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.tab.list' });
  return true;
}

export function resumeInAppBrowser(url: string): void {
  shellWebView()?.postMessage({ type: 'inAppBrowser.resume', url });
}

export function subscribeInAppBrowserActivation(onActivate: (url: string) => void): () => void {
  const host = shellWebView();
  if (!host) return () => undefined;
  const listener = (event: { data: unknown }) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === 'inAppBrowser.activate' && typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) onActivate(data.url);
  };
  host.addEventListener('message', listener);
  return () => host.removeEventListener('message', listener);
}

/** DOM owns layout; the shell displays the native page only in this reserved rectangle.
 * Poll geometry while mounted to also catch sidebar transitions, CSS zoom, scrolling and portals.
 * Messages are deduplicated. A modal or an overlapping menu hides the native HWND, never the dialog.
 */
export function trackInAppBrowserSurface(element: HTMLElement): () => void {
  const host = shellWebView();
  if (!host) return () => undefined;
  let frame = 0;
  let last = '';
  const update = () => {
    const r = element.getBoundingClientRect();
    const modal = [...document.querySelectorAll('[aria-modal="true"], dialog[open]')].some(el => el.getClientRects().length > 0);
    const points = [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]];
    const visible = r.width > 4 && r.height > 4 && !document.hidden && !modal && !document.body.dataset.panelResizing
      && points.every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
    const payload = JSON.stringify({ type: 'inAppBrowser.surface', visible,
      x: r.x, y: r.y, width: r.width, height: r.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    if (payload !== last) { host.postMessage(JSON.parse(payload)); last = payload; }
    frame = requestAnimationFrame(update);
  };
  update();
  return () => { cancelAnimationFrame(frame); host.postMessage({ type: 'inAppBrowser.surface', visible: false }); };
}

export function openInAppBrowser(url: string): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.open', url });
  return true;
}

export function navigateInAppBrowser(url: string): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.navigate', url });
  return true;
}

export function inAppBrowserBack(): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.back' });
  return true;
}

export function inAppBrowserForward(): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.forward' });
  return true;
}

export function inAppBrowserReload(): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.reload' });
  return true;
}

export function inAppBrowserOpenExternal(url?: string): boolean {
  const webview = shellWebView();
  if (!webview) return false;
  webview.postMessage({ type: 'inAppBrowser.openExternal', url: url ?? null });
  return true;
}

export function subscribeInAppBrowserState(
  onState: (state: InAppBrowserState) => void,
): () => void {
  const webview = shellWebView();
  if (!webview) return () => undefined;

  const onMessage = (event: { data: unknown }) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const rec = data as Record<string, unknown>;
    if (rec.type !== 'inAppBrowser.state') return;
    const tabs = Array.isArray(rec.tabs) ? rec.tabs.flatMap((value): InAppBrowserTab[] => {
      if (!value || typeof value !== 'object') return [];
      const tab = value as Record<string, unknown>;
      if (typeof tab.id !== 'string' || !tab.id) return [];
      return [{
        id: tab.id,
        url: typeof tab.url === 'string' ? tab.url : '',
        title: typeof tab.title === 'string' ? tab.title : '',
        active: Boolean(tab.active),
        loading: Boolean(tab.loading),
        primary: Boolean(tab.primary),
        controlled: Boolean(tab.controlled),
        observing: Boolean(tab.observing),
      }];
    }) : [];
    onState({
      visible: Boolean(rec.visible),
      url: typeof rec.url === 'string' ? rec.url : '',
      canGoBack: Boolean(rec.canGoBack),
      canGoForward: Boolean(rec.canGoForward),
      loading: Boolean(rec.loading),
      status: typeof rec.status === 'string' ? rec.status : '',
      activeTabId: typeof rec.activeTabId === 'string' ? rec.activeTabId : tabs.find((tab) => tab.active)?.id ?? 'main',
      returnTabId: typeof rec.returnTabId === 'string' && rec.returnTabId ? rec.returnTabId : null,
      tabs,
    });
  };

  webview.addEventListener('message', onMessage);
  // Mounting Preview after a chat link opened the shell must recover its state.
  webview.postMessage({ type: 'inAppBrowser.getState' });
  return () => webview.removeEventListener('message', onMessage);
}
