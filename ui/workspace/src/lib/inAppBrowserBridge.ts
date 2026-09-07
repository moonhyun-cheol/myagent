/** Bridge Preview/Chat → WPF shell BrowserWebView (real web access). */

type ChromeWebViewHost = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
};

export type InAppBrowserState = {
  visible: boolean;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  status: string;
};

function shellWebView(): ChromeWebViewHost | null {
  const chrome = (window as unknown as { chrome?: { webview?: ChromeWebViewHost } }).chrome;
  return chrome?.webview ?? null;
}

export function isShellInAppBrowserAvailable(): boolean {
  return shellWebView() !== null;
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
    onState({
      visible: Boolean(rec.visible),
      url: typeof rec.url === 'string' ? rec.url : '',
      canGoBack: Boolean(rec.canGoBack),
      canGoForward: Boolean(rec.canGoForward),
      loading: Boolean(rec.loading),
      status: typeof rec.status === 'string' ? rec.status : '',
    });
  };

  webview.addEventListener('message', onMessage);
  return () => webview.removeEventListener('message', onMessage);
}
