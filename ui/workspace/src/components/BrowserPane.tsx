import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  Bug,
  CaretDown,
  Check,
  GlobeSimple,
  Plus,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { isLocalPreviewUrl, normalizeBrowserUrl } from '../lib/browserUrl';
import {
  activateInAppBrowserTab,
  closeInAppBrowserTab,
  createInAppBrowserTab,
  inAppBrowserBack,
  inAppBrowserForward,
  inAppBrowserOpenExternal,
  inAppBrowserReload,
  isShellInAppBrowserAvailable,
  navigateInAppBrowser,
  openInAppBrowser,
  openInAppBrowserDevTools,
  resumeInAppBrowser,
  returnFromObservedBrowserTab,
  takeOverInAppBrowserTab,
  trackInAppBrowserSurface,
  subscribeInAppBrowserState,
  type InAppBrowserTab,
} from '../lib/inAppBrowserBridge';
import { useWorkspaceStore } from '../store/workspaceStore';

type ViewportPreset = {
  id: string;
  label: string;
  width: number | null;
  height: number | null;
};

const VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: 'phone', label: '스마트폰', width: 390, height: 844 },
  { id: 'phone-wide', label: '와이드 스마트폰', width: 844, height: 390 },
  { id: 'foldable', label: '폴더블', width: 673, height: 841 },
  { id: 'tablet', label: '태블릿', width: 768, height: 1024 },
  { id: 'laptop', label: '노트북', width: 1440, height: 900 },
  { id: 'desktop', label: 'PC', width: 1920, height: 1080 },
  { id: 'desktop-wide', label: '와이드 PC', width: 2560, height: 1440 },
  { id: 'custom', label: '사용자 지정', width: null, height: null },
];

const EXCESSIVE_TAB_WARNING_AT = 9;

function browserTabLabel(tab: InAppBrowserTab): string {
  const title = tab.title.trim();
  if (title && title !== '현재 인앱 웹 페이지') return title;
  if (!tab.url) return '새 탭';
  try { return new URL(tab.url).hostname || tab.url; } catch { return tab.url; }
}

function browserTabFavicon(tab: InAppBrowserTab): string | null {
  try {
    const url = new URL(tab.url);
    return /^https?:$/.test(url.protocol) ? `${url.origin}/favicon.ico` : null;
  } catch { return null; }
}

export function BrowserPane() {
  const browserInputUrl = useWorkspaceStore((s) => s.browserInputUrl);
  const browserLoadedUrl = useWorkspaceStore((s) => s.browserLoadedUrl);
  const storeCanGoBack = useWorkspaceStore((s) => s.browserHistoryIndex > 0);
  const storeCanGoForward = useWorkspaceStore(
    (s) => s.browserHistoryIndex >= 0 && s.browserHistoryIndex < s.browserHistory.length - 1,
  );
  const browserReloadKey = useWorkspaceStore((s) => s.browserReloadKey);
  const setBrowserInputUrl = useWorkspaceStore((s) => s.setBrowserInputUrl);
  const navigateBrowser = useWorkspaceStore((s) => s.navigateBrowser);
  const reloadBrowser = useWorkspaceStore((s) => s.reloadBrowser);
  const goBrowserBack = useWorkspaceStore((s) => s.goBrowserBack);
  const goBrowserForward = useWorkspaceStore((s) => s.goBrowserForward);
  const shellAvailable = isShellInAppBrowserAvailable();
  const [shellVisible, setShellVisible] = useState(false);
  const [shellLoading, setShellLoading] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [shellStatus, setShellStatus] = useState('');
  const [shellCanGoBack, setShellCanGoBack] = useState(false);
  const [shellCanGoForward, setShellCanGoForward] = useState(false);
  const [shellUrl, setShellUrl] = useState('');
  const [shellStateReceived, setShellStateReceived] = useState(false);
  const [shellTabs, setShellTabs] = useState<InAppBrowserTab[]>([]);
  const [returnTabId, setReturnTabId] = useState<string | null>(null);
  const hasShellState = useRef(false);
  const lastActiveTabId = useRef<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [viewportOpen, setViewportOpen] = useState(false);
  const [viewport, setViewport] = useState<ViewportPreset>(VIEWPORT_PRESETS[0]);
  const [customWidth, setCustomWidth] = useState('390');
  const [customHeight, setCustomHeight] = useState('844');

  const shellPageUrl = shellStateReceived
    ? shellUrl
    : browserLoadedUrl && !isLocalPreviewUrl(browserLoadedUrl) ? browserLoadedUrl : '';
  const useIframeSurface = Boolean(
    browserLoadedUrl && (!shellAvailable || isLocalPreviewUrl(browserLoadedUrl)),
  );
  const useShellSurface = Boolean(
    !useIframeSurface && shellAvailable && shellPageUrl && !isLocalPreviewUrl(shellPageUrl),
  );
  const activeBrowserUrl = useShellSurface ? shellPageUrl : useIframeSurface ? browserLoadedUrl : '';
  const canGoBack = useShellSurface ? shellCanGoBack : storeCanGoBack;
  const canGoForward = useShellSurface ? shellCanGoForward : storeCanGoForward;

  useEffect(() => {
    if (!shellAvailable) return undefined;
    return subscribeInAppBrowserState((state) => {
      const firstState = !hasShellState.current;
      hasShellState.current = true;
      setShellVisible(state.visible);
      setShellLoading(state.loading);
      setShellStatus(state.status);
      setShellCanGoBack(state.canGoBack);
      setShellCanGoForward(state.canGoForward);
      setShellUrl(state.url);
      setShellStateReceived(true);
      setShellTabs(state.tabs);
      setReturnTabId(state.returnTabId);
      const store = useWorkspaceStore.getState();
      const recoverUrl = firstState && !state.url && store.browserLoadedUrl
        && !isLocalPreviewUrl(store.browserLoadedUrl) ? store.browserLoadedUrl : '';
      if (recoverUrl) {
        resumeInAppBrowser(recoverUrl);
      }
      if (lastActiveTabId.current !== state.activeTabId) {
        lastActiveTabId.current = state.activeTabId;
        if (!recoverUrl) store.setBrowserInputUrl(state.url);
      }
      if (/^https?:\/\//i.test(state.url)) {
        if (state.url !== store.browserLoadedUrl) {
          store.navigateBrowser(state.url);
        }
      }
    });
  }, [shellAvailable]);

  useEffect(() => {
    if (!useShellSurface || !shellPageUrl) return;
    resumeInAppBrowser(shellPageUrl);
  }, [useShellSurface, shellPageUrl]);

  useEffect(() => {
    if (useShellSurface && surfaceRef.current) return trackInAppBrowserSurface(surfaceRef.current);
  }, [useShellSurface]);

  useEffect(() => {
    if (!viewportOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setViewportOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [viewportOpen]);

  const selectViewport = (preset: ViewportPreset) => {
    setViewport(preset);
    if (preset.width !== null) setCustomWidth(String(preset.width));
    if (preset.height !== null) setCustomHeight(String(preset.height));
    setViewportOpen(false);
  };

  const applyCustomViewport = () => {
    const width = Number.parseInt(customWidth, 10);
    const height = Number.parseInt(customHeight, 10);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      setMessage('가로·세로에 숫자를 넣으세요');
      return;
    }

    setMessage(null);
    setViewport({ id: 'custom', label: '사용자 지정', width, height });
    setViewportOpen(false);
  };

  const openExternal = () => {
    if (!activeBrowserUrl) return;
    if (inAppBrowserOpenExternal(activeBrowserUrl)) return;
    window.open(activeBrowserUrl, '_blank', 'noopener,noreferrer');
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = normalizeBrowserUrl(browserInputUrl);
    if (!url) {
      setMessage('웹 주소를 입력하세요. 예: example.com 또는 https://example.com');
      return;
    }
    setMessage(null);
    setBrowserInputUrl(url);
    navigateBrowser(url);

    if (shellAvailable && !isLocalPreviewUrl(url)) {
      // Real browsing happens in the shell WebView2 (not iframe — most sites block framing).
      if (!openInAppBrowser(url)) navigateInAppBrowser(url);
      // Sending a command is not evidence that the native browser is visible.
      setShellStatus('브라우저 열기를 요청했습니다.');
    }
  };

  const onBack = () => {
    if (useShellSurface && inAppBrowserBack()) return;
    goBrowserBack();
  };

  const onForward = () => {
    if (useShellSurface && inAppBrowserForward()) return;
    goBrowserForward();
  };

  const onReload = () => {
    if (!activeBrowserUrl) return;
    if (useShellSurface && inAppBrowserReload()) return;
    reloadBrowser();
  };

  const createTab = () => {
    setMessage(null);
    createInAppBrowserTab();
  };

  const closeTab = (tab: InAppBrowserTab) => {
    if (tab.primary || tab.controlled) return;
    closeInAppBrowserTab(tab.id);
  };

  const activeShellTab = shellTabs.find((tab) => tab.active) ?? null;

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink" aria-label="Preview 웹 뷰어">
      {shellAvailable ? (
        <div className="flex shrink-0 items-end gap-1 overflow-x-auto border-b border-line bg-panel px-2 pt-1.5" role="tablist" aria-label="웹 브라우저 탭">
          {shellTabs.map((tab) => {
            const favicon = browserTabFavicon(tab);
            const label = browserTabLabel(tab);
            return (
              <div
                key={tab.id}
                role="presentation"
                className={`group flex min-w-[120px] max-w-[220px] items-center rounded-t-md border border-b-0 px-1 ${tab.active ? 'border-line bg-ink text-text' : 'border-transparent text-muted hover:bg-hover hover:text-text'}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.active}
                  title={label}
                  onClick={() => activateInAppBrowserTab(tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1.5 text-left text-[11px]"
                >
                  {favicon ? <img src={favicon} alt="" className="size-3.5 shrink-0 rounded-sm" /> : <GlobeSimple size={14} className="shrink-0" />}
                  <span className="truncate">{label}</span>
                  {tab.controlled ? (
                    <span className="shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[9px] font-semibold text-accent" aria-label="에이전트 제어 중">AI</span>
                  ) : null}
                  {tab.loading ? <span className="shrink-0 text-accent" aria-label="로딩 중">•</span> : null}
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(tab)}
                  disabled={tab.primary || tab.controlled}
                  title={tab.primary ? '기본 탭은 유지됩니다' : tab.controlled ? '제어권을 가져온 뒤 닫을 수 있습니다' : `${label} 닫기`}
                  aria-label={`${label} 닫기`}
                  className="shrink-0 rounded p-1 text-muted opacity-70 hover:bg-panel-2 hover:text-text disabled:cursor-default disabled:opacity-25"
                >
                  <X size={12} weight="bold" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={createTab}
            disabled={shellTabs.length >= 12}
            title="새 탭"
            aria-label="새 브라우저 탭"
            className="mb-1 shrink-0 rounded-md p-1.5 text-muted hover:bg-hover hover:text-text disabled:opacity-35"
          >
            <Plus size={15} weight="bold" />
          </button>
        </div>
      ) : null}
      {activeShellTab?.controlled || returnTabId ? (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-accent/10 px-3 py-1.5 text-[11px] text-text">
          <span>{activeShellTab?.controlled ? (activeShellTab.observing ? '에이전트 제어 탭을 관전 중입니다.' : '에이전트가 이 탭을 제어 중입니다.') : '에이전트의 탭 제어가 종료되었습니다.'}</span>
          {activeShellTab?.controlled ? (
            <button type="button" onClick={() => takeOverInAppBrowserTab(activeShellTab.id)} className="rounded border border-accent/40 px-2 py-1 font-medium text-accent hover:bg-accent/10">
              제어 가져오기
            </button>
          ) : null}
          {returnTabId ? (
            <button type="button" onClick={() => returnFromObservedBrowserTab()} className="rounded px-2 py-1 text-muted hover:bg-hover hover:text-text">
              원래 탭으로
            </button>
          ) : null}
        </div>
      ) : null}
      {shellTabs.length >= EXCESSIVE_TAB_WARNING_AT ? (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-3 py-1.5 text-[11px] text-warning">
          <WarningCircle size={14} weight="fill" />
          탭이 많으면 메모리 사용량이 늘 수 있습니다. 사용하지 않는 탭을 닫아 주세요.
        </div>
      ) : null}
      <form
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-2"
        onSubmit={submit}
      >
        <button
          type="button"
          onClick={onBack}
          disabled={!canGoBack}
          title="뒤로"
          className="rounded-md p-1.5 text-muted hover:bg-ink hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
        >
          <ArrowLeft size={16} weight="bold" />
        </button>
        <button
          type="button"
          onClick={onForward}
          disabled={!canGoForward}
          title="앞으로"
          className="rounded-md p-1.5 text-muted hover:bg-ink hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
        >
          <ArrowRight size={16} weight="bold" />
        </button>
        <button
          type="button"
          onClick={onReload}
          disabled={!activeBrowserUrl}
          title="새로고침"
          className="rounded-md p-1.5 text-muted hover:bg-ink hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
        >
          <ArrowClockwise size={16} weight="bold" />
        </button>
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-ink px-2.5 py-1.5 focus-within:border-accent/70">
          <GlobeSimple size={15} className="shrink-0 text-muted" />
          <input
            value={browserInputUrl}
            onChange={(event) => setBrowserInputUrl(event.target.value)}
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="example.com 또는 https://…"
            aria-label="웹 주소"
            className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted"
          />
        </label>
        <button type="button" onClick={() => activeShellTab && openInAppBrowserDevTools(activeShellTab.id)}
          disabled={!useShellSurface || !activeShellTab || activeShellTab.controlled}
          title={activeShellTab?.controlled ? '제어권을 가져온 뒤 개발자 도구를 열 수 있습니다' : '개발자 도구 (F12)'}
          aria-label="개발자 도구 열기 (F12)"
          className="shrink-0 rounded-md p-1.5 text-muted hover:bg-hover disabled:opacity-35">
          <Bug size={16} />
        </button>
        <button type="button" onClick={openExternal} disabled={!activeBrowserUrl}
          title="기본 브라우저에서 열기" aria-label="기본 브라우저에서 열기"
          className="shrink-0 rounded-md p-1.5 text-muted hover:bg-hover disabled:opacity-35">
          <ArrowSquareOut size={16} />
        </button>
        {!useShellSurface && <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setViewportOpen((open) => !open)}
            aria-expanded={viewportOpen}
            aria-haspopup="dialog"
            disabled={useShellSurface}
            title={useShellSurface ? '외부 사이트는 인앱 브라우저에서 실제 크기로 표시됩니다' : '화면 크기'}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-ink px-2 py-1.5 text-[11px] text-muted hover:border-accent/50 hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span>{viewport.label}</span>
            <span className="text-[10px] text-muted/70">{viewport.width} × {viewport.height}</span>
            <CaretDown size={13} weight="bold" />
          </button>
          {viewportOpen && !useShellSurface ? (
            <div
              role="dialog"
              aria-label="웹 화면 크기 설정"
              className="absolute right-0 top-[calc(100%+8px)] z-20 w-[284px] rounded-lg border border-line bg-panel p-3 shadow-2xl"
            >
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-text">웹 화면 크기</p>
                  <p className="mt-0.5 text-[10px] text-muted">로컬 미리보기용</p>
                </div>
                <button
                  type="button"
                  onClick={() => setViewportOpen(false)}
                  className="rounded px-1.5 py-1 text-[10px] text-muted hover:bg-ink hover:text-text"
                >
                  Esc
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {VIEWPORT_PRESETS.map((preset) => {
                  const selected = viewport.id === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => selectViewport(preset)}
                      className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-left transition ${
                        selected
                          ? 'border-accent/60 bg-accent/10 text-text'
                          : 'border-line text-muted hover:border-accent/40 hover:text-text'
                      }`}
                    >
                      <span className="min-w-0 truncate text-[11px]">{preset.label}</span>
                      <span className="ml-1 shrink-0 text-[9px] text-muted/70">
                        {preset.width}×{preset.height}
                      </span>
                      {selected ? <Check size={12} className="ml-1 shrink-0 text-accent" weight="bold" /> : null}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 border-t border-line pt-3">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">직접 설정</p>
                <div className="flex items-end gap-2">
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-[10px] text-muted">가로</span>
                    <input
                      value={customWidth}
                      onChange={(event) => setCustomWidth(event.target.value)}
                      type="number"
                      min={240}
                      max={3840}
                      step={1}
                      className="w-full rounded-md border border-line bg-ink px-2 py-1.5 text-xs text-text outline-none focus:border-accent/70"
                      aria-label="가로 너비"
                    />
                  </label>
                  <span className="pb-2 text-muted">×</span>
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-[10px] text-muted">세로</span>
                    <input
                      value={customHeight}
                      onChange={(event) => setCustomHeight(event.target.value)}
                      type="number"
                      min={240}
                      max={3840}
                      step={1}
                      className="w-full rounded-md border border-line bg-ink px-2 py-1.5 text-xs text-text outline-none focus:border-accent/70"
                      aria-label="세로 높이"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={applyCustomViewport}
                    className="rounded-md bg-accent px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-accent/90"
                  >
                    적용
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>}
      </form>

      {message ? (
        <p className="shrink-0 border-b border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-700">
          {message}
        </p>
      ) : null}

      {useShellSurface && (shellLoading || (shellStatus && !['탐색 완료', '닫힘'].includes(shellStatus))) ? (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted">
          <span>{shellLoading ? '페이지를 여는 중…' : `웹 페이지 상태 · ${shellStatus}`}</span>
          {!shellLoading && <>
            <button type="button" onClick={onReload} className="ui-secondary">다시 시도</button>
            <button type="button" onClick={() => surfaceRef.current?.closest('section')?.querySelector<HTMLInputElement>('input')?.focus()} className="ui-secondary">주소 수정</button>
            <button type="button" onClick={openExternal} className="ui-secondary">외부에서 열기</button>
          </>}
        </div>
      ) : null}
      <div className={`relative min-h-0 flex-1 ${useShellSurface ? 'overflow-hidden' : 'overflow-auto bg-[#d7dcd9] p-4'}`}>
        {useShellSurface ? (
          <div ref={surfaceRef} data-native-browser-slot data-native-visible={shellVisible} className="h-full w-full bg-panel" aria-label="인앱 웹 페이지" />
        ) : useIframeSurface ? (
          <div className="flex min-h-full min-w-full items-start justify-center">
            <div
              className="shrink-0 overflow-hidden bg-white shadow-[0_8px_30px_rgba(15,23,42,0.16)] transition-[width,height] duration-200"
              style={{
                width: viewport.width ?? undefined,
                height: viewport.height ?? undefined,
              }}
            >
              <iframe
                key={`${browserLoadedUrl}:${browserReloadKey}`}
                src={browserLoadedUrl ?? undefined}
                title={`Preview 웹 페이지 · ${viewport.label} ${viewport.width}×${viewport.height}`}
                referrerPolicy="strict-origin-when-cross-origin"
                className="block h-full w-full border-0"
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 bg-ink px-6 text-center">
            <GlobeSimple size={34} className="text-accent" weight="duotone" />
            <div>
              <p className="text-sm font-medium text-text">웹 미리보기</p>
              <p className="mt-1 text-xs text-muted">
                {shellAvailable
                  ? '주소를 입력한 뒤 Enter — 실제 사이트는 인앱 브라우저로 열립니다'
                  : '주소 입력 후 Enter (로컬 서버 미리보기에 적합)'}
              </p>
            </div>
          </div>
        )}
      </div>

      {browserLoadedUrl && !useShellSurface ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-panel px-3 py-1.5">
          <p className="min-w-0 truncate text-[10px] text-muted">
            {useShellSurface
              ? '실제 접속: 오른쪽 인앱 브라우저'
              : shellAvailable
                ? '로컬 미리보기 (디바이스 프레임)'
                : 'iframe 미리보기 — 차단되면 기본 브라우저 사용'}
          </p>
          <button
            type="button"
            onClick={openExternal}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-muted hover:border-accent/50 hover:text-text"
          >
            <ArrowSquareOut size={14} weight="bold" />
            기본 브라우저에서 열기
          </button>
        </div>
      ) : null}
    </section>
  );
}
