import {
  ArrowLeft,
  CaretDown,
  CheckCircle,
  Key,
  Plus,
  Trash,
  UserCircle,
  X,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import {
  createUserProvider,
  deleteProviderKey,
  deleteUserProvider,
  fetchCompanyModelSettings,
  listProviders,
  saveCompanyModelSelection,
  saveProviderKey,
  setDefaultProvider,
  testProvider,
  type ProviderPublic,
  type CompanyModelSettings,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';
import { useWorkspaceStore } from '../store/workspaceStore';

const COMPANY_ID = 'custom';
const PERSONAL_IDS = ['openai', 'anthropic', 'google'] as const;

const PERSONAL_COPY: Record<string, { title: string; mark: string; note: string }> = {
  openai: { title: 'OpenAI', mark: 'O', note: '개인 OpenAI API 키' },
  anthropic: { title: 'Anthropic', mark: 'A', note: '개인 Anthropic API 키' },
  google: { title: 'Gemini', mark: 'G', note: '개인 Google AI API 키' },
};

function companyModelLabel(id: string) {
  return id.replace(/^open_webui_openrouter_integration\./, '').replace('/', ' · ');
}

function ProviderMark({ text, company = false }: { text: string; company?: boolean }) {
  return (
    <div
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg font-bold ${
        company ? 'bg-accent/20 text-accent' : 'bg-panel-2 text-text'
      }`}
    >
      {text}
    </div>
  );
}

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-muted/50'}`} />
  );
}

function secretBackendLabel(backend: ProviderPublic['secret_backend']): string {
  if (backend === 'windows-dpapi') return 'Windows 사용자 보호 저장소';
  if (backend === 'macos-keychain') return 'macOS Keychain';
  return 'OS 보안 저장소';
}

export function ModelManagementModal({
  open,
  onClose,
  embedded = false,
}: {
  open: boolean;
  onClose: () => void;
  embedded?: boolean;
}) {
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customForm, setCustomForm] = useState({
    compatibility: 'openai' as 'openai' | 'anthropic',
    name: '',
    base_url: '',
    model_id: '',
    api_key: '',
  });
  const [companyModels, setCompanyModels] = useState<CompanyModelSettings | null>(null);
  const [companyModelsOpen, setCompanyModelsOpen] = useState(false);
  const [companyModelDraft, setCompanyModelDraft] = useState<string[]>([]);
  const [companyModelSearch, setCompanyModelSearch] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refreshModelPicker = useWorkspaceStore((s) => s.refreshModelPicker);
  const licenseMode = useWorkspaceStore((s) => s.licenseMode);
  const readOnly = licenseMode !== null && licenseMode !== 'full';

  const refresh = async () => {
    const next = await listProviders();
    setProviders(next);
    return next;
  };

  useEffect(() => {
    if (!open) return;
    void refresh().catch((err) => setMessage(err instanceof Error ? err.message : '모델 목록 실패'));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (companyModelsOpen) setCompanyModelsOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, companyModelsOpen]);

  const company = providers.find((p) => p.id === COMPANY_ID);
  const personal = PERSONAL_IDS.map((id) => providers.find((p) => p.id === id)).filter(
    (p): p is ProviderPublic => Boolean(p),
  );
  const personalConfigured = providers.filter(
    (p) => p.configured && (PERSONAL_IDS.includes(p.id as (typeof PERSONAL_IDS)[number]) || p.user_defined),
  ).length;
  const advancedProviders = useMemo(
    () => providers.filter((p) => p.user_defined),
    [providers],
  );
  const companyModelChoices = useMemo(() => {
    if (!companyModels) return [];
    const query = companyModelSearch.trim().toLowerCase();
    const selected = new Set(companyModelDraft);
    return companyModels.available
      .filter((id) => !selected.has(id))
      .filter((id) => !query || companyModelLabel(id).toLowerCase().includes(query))
      .slice(0, 40);
  }, [companyModels, companyModelDraft, companyModelSearch]);

  const openCompanyModels = async () => {
    setCompanyModelsOpen(true);
    setBusy(true);
    setMessage('MY 모델 목록을 불러오는 중…');
    try {
      const settings = await fetchCompanyModelSettings(true);
      setCompanyModels(settings);
      setCompanyModelDraft(settings.selected);
      setMessage(settings.available.length ? '' : '원격 목록을 받지 못했습니다. 기본 세트는 그대로 사용할 수 있습니다.');
    } catch (err) {
      const detail = err instanceof Error ? err.message : '';
      setMessage(
        /fetch failed|network|failed to fetch/i.test(detail)
          ? 'MY 모델 목록을 불러오지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.'
          : detail || 'MY 모델 목록을 불러오지 못했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };

  const persistCompanyModels = async (reset = false) => {
    if (!reset && companyModelDraft.length === 0) {
      setMessage('MY 모델을 하나 이상 선택하세요.');
      return;
    }
    setBusy(true);
    try {
      await saveCompanyModelSelection(reset ? null : companyModelDraft);
      const settings = await fetchCompanyModelSettings(false);
      setCompanyModels(settings);
      setCompanyModelDraft(settings.selected);
      await refreshModelPicker();
      setMessage(reset ? 'MY 기본 모델 세트를 복원했습니다.' : 'MY 모델 구성을 저장했습니다.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'MY 모델 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (provider: ProviderPublic) => {
    setEditingId(provider.id);
    setKeyDraft('');
    setModelDraft(provider.model_id || provider.default_model || '');
    setMessage('');
  };

  const connect = async (provider: ProviderPublic, makeDefault = false) => {
    if (!keyDraft.trim() && !provider.configured) {
      setMessage('API 키를 입력하세요.');
      return;
    }
    setBusy(true);
    setMessage(`${provider.name} 연결 확인 중…`);
    try {
      let next = await saveProviderKey(provider.id, {
        api_key: keyDraft,
        model_id: modelDraft.trim() || undefined,
      });
      const result = await testProvider(provider.id);
      if (!result.ok) throw new Error(result.note || result.message || '연결 테스트 실패');
      if (makeDefault || provider.id === COMPANY_ID) next = await setDefaultProvider(provider.id);
      setProviders(next.length ? next : await listProviders());
      await refreshModelPicker();
      setEditingId(null);
      setKeyDraft('');
      setMessage(`${provider.name} 연결됨`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '연결 실패');
    } finally {
      setBusy(false);
    }
  };

  const test = async (provider: ProviderPublic) => {
    setBusy(true);
    setMessage(`${provider.name} 테스트 중…`);
    try {
      const result = await testProvider(provider.id);
      setMessage(result.note || result.message || (result.ok ? `${provider.name} 연결 정상` : '연결 실패'));
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '연결 테스트 실패');
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (provider: ProviderPublic) => {
    setBusy(true);
    try {
      setProviders(await setDefaultProvider(provider.id));
      await refreshModelPicker();
      setMessage(`${provider.name}을 기본 연결로 설정했습니다.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '기본 연결 설정 실패');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: ProviderPublic) => {
    const ok = await confirmDialog({
      title: provider.user_defined ? '개인 연결 삭제' : 'API 키 삭제',
      message: `${provider.name} 연결 정보를 이 PC에서 삭제할까요?`,
      confirmLabel: '삭제',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      setProviders(provider.user_defined ? await deleteUserProvider(provider.id) : await deleteProviderKey(provider.id));
      await refreshModelPicker();
      setMessage(`${provider.name} 연결 정보를 삭제했습니다.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '삭제 실패');
    } finally {
      setBusy(false);
    }
  };

  const addCustom = async () => {
    setBusy(true);
    try {
      setProviders(await createUserProvider(customForm));
      await refreshModelPicker();
      setCustomForm({ compatibility: 'openai', name: '', base_url: '', model_id: '', api_key: '' });
      setCustomOpen(false);
      setMessage('사용자 지정 연결을 추가했습니다.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '사용자 지정 연결 실패');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const editPanel = (provider: ProviderPublic, companyProvider = false) =>
    editingId === provider.id ? (
      <div className="mt-4 rounded-xl border border-line bg-ink/70 p-3">
        <label className="mb-1 block text-[11px] font-medium text-muted">
          {provider.configured ? '새 API 키로 교체' : 'API 키'}
        </label>
        <input
          type="password"
          value={keyDraft}
          onChange={(event) => setKeyDraft(event.target.value)}
          placeholder={provider.configured ? '변경할 때만 입력' : `${secretBackendLabel(provider.secret_backend)}에 보호됩니다`}
          className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          autoFocus
        />
        {companyProvider ? (
          <p className="mt-2 text-[11px] text-muted">
            고정 엔드포인트 · {provider.base_url} · Responses API
          </p>
        ) : null}
        {!companyProvider ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-muted">모델 ID 고급 설정</summary>
            <input
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              className="mt-2 w-full rounded-lg border border-line bg-panel px-3 py-2 text-xs outline-none focus:border-accent"
              placeholder="기본 모델 사용"
            />
          </details>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy || readOnly}
            onClick={() => void connect(provider, companyProvider)}
            className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink disabled:opacity-50"
          >
            저장하고 연결
          </button>
          <button
            type="button"
            onClick={() => setEditingId(null)}
            className="rounded-lg border border-line px-3 py-2 text-xs text-muted hover:text-text"
          >
            취소
          </button>
        </div>
      </div>
    ) : null;

  const panel = (
      <section
        role={embedded ? 'region' : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-label="모델 관리"
        className={`model-manager-light flex w-full flex-col overflow-hidden bg-panel text-text ${
          embedded
            ? 'h-full min-h-0'
            : 'max-h-[90vh] max-w-6xl rounded-2xl border border-line shadow-[0_28px_90px_rgba(0,0,0,0.32)]'
        }`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between border-b border-line bg-panel px-7 py-5">
          <div className="flex items-start gap-3">
            {companyModelsOpen ? (
              <button
                type="button"
                onClick={() => setCompanyModelsOpen(false)}
                className="mt-0.5 rounded-lg border border-line bg-panel px-2.5 py-2 text-muted hover:bg-panel-2 hover:text-text"
                aria-label="모델 관리로 돌아가기"
              >
                <ArrowLeft size={17} />
              </button>
            ) : null}
            <div>
              <h2 className="text-xl font-semibold text-text">{companyModelsOpen ? 'MY 모델 구성' : '모델 관리'}</h2>
              <p className="mt-1 text-sm text-muted">
                {companyModelsOpen
                  ? 'MY에서 제공하는 모델 중 작업에 표시할 항목을 선택합니다.'
                  : 'MY 연결을 우선 사용하고, 필요한 개인 연결만 추가합니다.'}
              </p>
            </div>
          </div>
          {!embedded ? (
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-muted hover:bg-panel-2 hover:text-text" aria-label="닫기">
              <X size={18} />
            </button>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-7 py-6">
          {message ? (
            <div className="mb-5 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span>{message}</span>
              {companyModelsOpen ? (
                <button type="button" disabled={busy} onClick={() => void openCompanyModels()} className="ml-4 shrink-0 font-semibold text-amber-800 hover:underline">
                  다시 시도
                </button>
              ) : null}
            </div>
          ) : null}

          {companyModelsOpen ? (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
              <section className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4 border-b border-line pb-4">
                  <div>
                    <p className="text-base font-semibold">선택된 MY 모델</p>
                    <p className="mt-1 text-sm text-muted">채팅 모델 선택기에 표시할 모델입니다.</p>
                  </div>
                  <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                    {companyModelDraft.length} / 40
                  </span>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {companyModelDraft.length ? companyModelDraft.map((id) => (
                    <div key={id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel-2/50 px-3 py-3">
                      <span className="min-w-0 truncate text-sm font-medium" title={companyModelLabel(id)}>{companyModelLabel(id)}</span>
                      <button
                        type="button"
                        onClick={() => setCompanyModelDraft((items) => items.filter((item) => item !== id))}
                        className="shrink-0 rounded-md px-2 py-1 text-xs text-muted hover:bg-red-50 hover:text-red-600"
                      >
                        제거
                      </button>
                    </div>
                  )) : (
                    <div className="rounded-xl border border-dashed border-line bg-panel-2/50 px-4 py-8 text-center text-sm text-muted sm:col-span-2">
                      오른쪽 검색 결과에서 모델을 추가하세요.
                    </div>
                  )}
                </div>
              </section>

              <aside className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
                <p className="text-base font-semibold">MY 전체 모델 검색</p>
                <p className="mt-1 text-sm leading-5 text-muted">OpenRouter의 긴 목록을 직접 펼치지 않고 이름으로 찾습니다.</p>
                <input
                  value={companyModelSearch}
                  onChange={(event) => setCompanyModelSearch(event.target.value)}
                  placeholder={busy ? '모델 목록 확인 중…' : '예: claude, gpt, gemini'}
                  className="mt-4 w-full rounded-xl border border-line bg-panel px-3 py-2.5 text-sm text-text outline-none placeholder:text-muted/70 focus:border-accent focus:ring-2 focus:ring-accent/15"
                  autoFocus
                />
                <div className="mt-3 max-h-[360px] space-y-1 overflow-y-auto pr-1">
                  {companyModelSearch.trim() ? (
                    companyModelChoices.length ? companyModelChoices.map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          setCompanyModelDraft((items) => [...items, id]);
                          setCompanyModelSearch('');
                        }}
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-muted hover:bg-emerald-50 hover:text-emerald-800"
                      >
                        {companyModelLabel(id)}
                      </button>
                    )) : <p className="rounded-lg bg-panel-2 px-3 py-4 text-center text-sm text-muted">검색 결과가 없습니다.</p>
                  ) : <p className="rounded-lg bg-panel-2 px-3 py-4 text-center text-sm text-muted">모델 이름을 입력하세요.</p>}
                </div>
              </aside>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-panel px-5 py-4 shadow-sm lg:col-span-2">
                <p className="text-sm text-muted">변경 내용은 이 PC의 사용자 설정에만 저장됩니다.</p>
                <div className="flex gap-2">
                  <button type="button" disabled={busy || readOnly} onClick={() => void persistCompanyModels(true)} className="rounded-lg border border-line bg-panel px-4 py-2.5 text-sm font-medium text-muted hover:bg-panel-2 disabled:opacity-50">
                    기본 세트 복원
                  </button>
                  <button type="button" disabled={busy || readOnly} onClick={() => void persistCompanyModels(false)} className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-dim disabled:opacity-50">
                    선택 저장
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>

          <div className="mb-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
            <div className="rounded-2xl border border-accent/35 bg-accent/5 p-4">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-accent">MY 기본 연결</p>
              {company ? (
                <>
                  <div className="flex items-center gap-3">
                    <ProviderMark text="MY" company />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-semibold">MY OpenRouter</p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                        <ConnectionDot connected={company.configured} />
                        {company.configured ? '연결됨 · Responses 기본' : 'OpenRouter API 키 설정 필요'}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void openCompanyModels()}
                        className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-muted hover:text-text"
                      >
                        모델 구성
                      </button>
                      <button
                        type="button"
                        onClick={() => (company.configured ? void test(company) : beginEdit(company))}
                        className="rounded-lg border border-accent/40 px-3 py-2 text-xs font-medium text-accent hover:bg-accent/10"
                      >
                        {company.configured ? '연결 확인' : '연결하기'}
                      </button>
                    </div>
                  </div>
                  {company.configured ? (
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                      {!company.is_default ? (
                        <button type="button" onClick={() => void makeDefault(company)} className="rounded-md bg-accent/15 px-2 py-1 text-accent">
                          기본으로 사용
                        </button>
                      ) : <span className="rounded-md bg-accent/15 px-2 py-1 text-accent">현재 기본</span>}
                      <button type="button" onClick={() => beginEdit(company)} className="rounded-md border border-line px-2 py-1 text-muted hover:text-text">키 교체</button>
                    </div>
                  ) : null}
                  {editPanel(company, true)}
                </>
              ) : <p className="text-sm text-muted">MY 프로바이더 구성을 찾을 수 없습니다.</p>}
            </div>

            <div className="rounded-2xl border border-line bg-ink/50 p-4">
              <UserCircle size={24} className="text-muted" />
              <p className="mt-3 text-2xl font-semibold">{personalConfigured}</p>
              <p className="text-xs text-muted">연결된 개인 모델</p>
              <p className="mt-3 text-[10px] leading-relaxed text-muted">
                API 키는 {secretBackendLabel(company?.secret_backend)}로 보호됩니다.
              </p>
            </div>
          </div>

          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">개인 모델 추가</h3>
              <p className="mt-1 text-[11px] text-muted">필요한 서비스만 연결하세요. MY 모델은 계속 기본으로 유지됩니다.</p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {personal.map((provider) => {
              const copy = PERSONAL_COPY[provider.id];
              return (
                <div key={provider.id} className={`rounded-2xl border p-4 ${provider.configured ? 'border-accent/30 bg-accent/5' : 'border-line bg-ink/35'}`}>
                  <div className="flex items-center gap-3">
                    <ProviderMark text={copy.mark} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{copy.title}</p>
                      <p className="truncate text-[11px] text-muted">{copy.note}</p>
                    </div>
                    {provider.configured ? <CheckCircle size={18} weight="fill" className="text-accent" /> : null}
                  </div>
                  <p className="mt-4 flex items-center gap-1.5 text-[11px] text-muted">
                    <ConnectionDot connected={provider.configured} />
                    {provider.configured ? `연결됨 · ${provider.key_hint ?? '키 저장됨'}` : '연결하지 않음'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => beginEdit(provider)} className="rounded-lg bg-panel-2 px-2.5 py-1.5 text-[11px] text-text hover:bg-line">
                      {provider.configured ? '설정' : '연결'}
                    </button>
                    {provider.configured ? (
                      <>
                        <button type="button" onClick={() => void test(provider)} className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-muted hover:text-text">테스트</button>
                        {!provider.is_default ? <button type="button" onClick={() => void makeDefault(provider)} className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-muted hover:text-text">기본</button> : null}
                      </>
                    ) : null}
                  </div>
                  {editPanel(provider)}
                </div>
              );
            })}
          </div>

          <div className="mt-5 rounded-2xl border border-line bg-ink/25">
            <button
              type="button"
              onClick={() => setAdvancedOpen((value) => !value)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <span>
                <span className="block text-sm font-medium">기타 호환 API</span>
                <span className="mt-0.5 block text-xs text-muted">OpenAI 호환 또는 Anthropic 호환 엔드포인트만 추가합니다.</span>
              </span>
              <CaretDown size={15} className={`text-muted transition ${advancedOpen ? 'rotate-180' : ''}`} />
            </button>
            {advancedOpen ? (
              <div className="border-t border-line p-4">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-[11px] font-medium text-muted">호환 API 연결</p>
                  <button type="button" onClick={() => setCustomOpen((value) => !value)} className="inline-flex items-center gap-1 rounded-lg bg-accent/15 px-2 py-1 text-[10px] text-accent">
                    <Plus size={11} /> 호환 연결 추가
                  </button>
                </div>
                {customOpen ? (
                  <div className="mb-4 grid gap-2 rounded-xl border border-line bg-panel p-3 md:grid-cols-2">
                    <div className="flex gap-2 md:col-span-2">
                      {(['openai', 'anthropic'] as const).map((compatibility) => (
                        <button
                          key={compatibility}
                          type="button"
                          onClick={() => setCustomForm((form) => ({ ...form, compatibility }))}
                          className={`flex-1 rounded-lg border px-3 py-2 text-left ${customForm.compatibility === compatibility ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted'}`}
                        >
                          <span className="block text-xs font-semibold">{compatibility === 'openai' ? 'OpenAI 호환' : 'Anthropic 호환'}</span>
                          <span className="mt-0.5 block text-[9px]">
                            {compatibility === 'openai' ? 'Responses 우선 · 필요 시 Chat Completions로 구성' : 'Anthropic Messages 고정'}
                          </span>
                        </button>
                      ))}
                    </div>
                    {(['name', 'base_url', 'model_id', 'api_key'] as const).map((field) => (
                      <input
                        key={field}
                        type={field === 'api_key' ? 'password' : 'text'}
                        value={customForm[field]}
                        onChange={(event) => setCustomForm((form) => ({ ...form, [field]: event.target.value }))}
                        placeholder={{ name: '표시 이름', base_url: 'Base URL', model_id: '모델 ID', api_key: 'API Key' }[field]}
                        className="rounded-lg border border-line bg-ink px-3 py-2 text-xs outline-none focus:border-accent"
                      />
                    ))}
                    <button type="button" disabled={busy || readOnly} onClick={() => void addCustom()} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink disabled:opacity-50">호환 연결 추가</button>
                  </div>
                ) : null}
                <div className="mb-4 grid gap-2 md:grid-cols-2">
                  {advancedProviders.map((provider) => (
                    <div key={provider.id} className="rounded-xl border border-line bg-panel px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium">{provider.name}</p>
                          <p className="text-[10px] text-muted">
                            {provider.compatibility === 'anthropic' ? 'Anthropic 호환' : provider.compatibility === 'openai' ? 'OpenAI 호환' : '기존 호환 연결'} · {provider.configured ? '연결됨' : '미설정'}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          <button type="button" onClick={() => beginEdit(provider)} className="rounded-md border border-line px-2 py-1 text-[10px] text-muted">설정</button>
                          {provider.configured ? <button type="button" onClick={() => void remove(provider)} className="rounded-md border border-line p-1 text-muted hover:text-red-400" aria-label="삭제"><Trash size={12} /></button> : null}
                        </div>
                      </div>
                      {editPanel(provider)}
                    </div>
                  ))}
                  {advancedProviders.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted md:col-span-2">
                      추가한 호환 API가 없습니다.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
            </>
          )}
        </div>

        {!embedded ? (
          <footer className="flex shrink-0 items-center justify-between border-t border-line bg-panel px-7 py-3.5">
            <p className="flex items-center gap-1.5 text-xs text-muted"><Key size={13} />API 키는 {secretBackendLabel(company?.secret_backend)}로 보호되며 다시 표시되지 않습니다.</p>
            <button type="button" onClick={onClose} className="rounded-lg bg-panel-2 px-4 py-2 text-sm font-medium hover:bg-line">닫기</button>
          </footer>
        ) : null}
      </section>
  );

  if (embedded) return panel;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/55 p-5 backdrop-blur-sm" onMouseDown={onClose}>
      {panel}
    </div>
  );
}
