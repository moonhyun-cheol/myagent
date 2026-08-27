import { CheckCircle, DownloadSimple, MinusCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchOptionalRuntimes,
  installOptionalRuntimes,
  type OptionalRuntimeCatalogFeature,
  type OptionalRuntimeStatusItem,
  type OptionalRuntimesPayload,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';

interface SettingsFeaturesPageProps {
  readOnly: boolean;
}

function FeatureRow({
  item,
  open,
  onOpen,
}: {
  item: OptionalRuntimeCatalogFeature;
  open?: boolean;
  onOpen?: () => void;
}) {
  const body = open && item.detail ? item.detail : item.summary;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-xl border border-line bg-[#fafbf8] px-4 py-3 text-left hover:border-accent/50"
      >
        <p className="text-sm font-semibold text-text">{item.label}</p>
        <p className="mt-1 text-xs leading-5 text-muted">{body}</p>
      </button>
    </li>
  );
}

export function SettingsFeaturesPage({ readOnly }: SettingsFeaturesPageProps) {
  const [doc, setDoc] = useState<OptionalRuntimesPayload | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchOptionalRuntimes();
    setDoc(next);
    setPicked(
      Object.fromEntries(next.optionals.map((item) => [item.id, !item.installed])),
    );
  }, []);

  useEffect(() => {
    void refresh().catch((error) => {
      setMessage(error instanceof Error ? error.message : '기능 목록을 불러오지 못했습니다.');
    });
  }, [refresh]);

  const installPicked = async (items: OptionalRuntimeStatusItem[]) => {
    const ids = items.filter((item) => picked[item.id] && !item.installed).map((item) => item.id);
    if (ids.length === 0) {
      setMessage('설치할 기능을 체크하세요.');
      return;
    }
    const labels = items.filter((item) => ids.includes(item.id)).map((item) => item.label).join(', ');
    const ok = await confirmDialog({
      title: '선택 기능 설치',
      message: `${labels}을(를) 지금 다운로드합니다. 인터넷이 필요하며 몇 분 걸릴 수 있습니다.`,
      confirmLabel: '설치',
      cancelLabel: '취소',
    });
    if (!ok) return;
    setBusyId(ids.join(','));
    setMessage('다운로드 중… 창을 닫지 마세요.');
    try {
      const result = await installOptionalRuntimes(ids);
      setMessage(result.ok ? `설치됨 · ${labels}` : result.log || '설치에 실패했습니다.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '설치 실패');
    } finally {
      setBusyId(null);
    }
  };

  const optionals = doc?.optionals ?? [];
  const missing = optionals.filter((item) => !item.installed);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">기능</h2>
        <p className="mt-1 text-sm text-muted">
          기본 기능은 이미 들어 있습니다. 이름을 누르면 무엇을 하는지, 언제 받으면 되는지를 짧게 보여 줍니다.
        </p>
      </header>

      {message ? (
        <p data-testid="features-settings-message" className="mb-5 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">
          {message}
        </p>
      ) : null}

      <section className="mb-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">선택 다운로드</h3>
            <p className="mt-0.5 text-xs text-muted">설치 화면에서 건너뛴 항목을 나중에 받을 수 있습니다.</p>
          </div>
          <button
            type="button"
            data-testid="features-install-selected"
            disabled={readOnly || Boolean(busyId) || missing.length === 0}
            onClick={() => void installPicked(optionals)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <DownloadSimple size={17} /> 선택한 항목 설치
          </button>
        </div>
        <ul className="space-y-2">
          {optionals.map((item) => (
            <li key={item.id} className="flex items-start gap-3 rounded-xl border border-line bg-[#fafbf8] px-4 py-3">
              <input
                type="checkbox"
                data-testid={`feature-check-${item.id}`}
                checked={item.installed ? true : Boolean(picked[item.id])}
                disabled={readOnly || item.installed || Boolean(busyId)}
                onChange={(event) => {
                  setPicked((current) => ({ ...current, [item.id]: event.target.checked }));
                  setOpenId(item.id);
                }}
                className="mt-1 h-4 w-4 accent-[#0f8f83]"
              />
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => setOpenId(item.id)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-text">{item.label}</p>
                  {item.size_hint ? <span className="text-xs text-muted">{item.size_hint}</span> : null}
                  {item.installed ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-accent">
                      <CheckCircle size={14} /> 설치됨
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-muted">
                      <MinusCircle size={14} /> 미설치
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted">{item.summary}</p>
                {openId === item.id && item.detail ? (
                  <p data-testid={`feature-detail-${item.id}`} className="mt-2 text-sm leading-6 text-text">
                    {item.detail}
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-muted">눌러서 언제 받으면 되는지 보기</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <h3 className="font-semibold">항상 포함</h3>
        <p className="mb-3 mt-0.5 text-xs text-muted">이름을 누르면 짧은 설명이 열립니다. 추가 다운로드는 없습니다.</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {(doc?.catalog.core_features ?? []).map((item) => (
            <FeatureRow key={item.id} item={item} open={openId === item.id} onOpen={() => setOpenId(item.id)} />
          ))}
        </ul>
      </section>

      <section className="mb-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <h3 className="font-semibold">라이선스로 열리는 기능</h3>
        <p className="mb-3 mt-0.5 text-xs text-muted">프로그램은 이미 들어 있습니다. 이름을 누르면 설명을 봅니다.</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {(doc?.catalog.license_features ?? []).map((item) => (
            <FeatureRow key={item.id} item={item} open={openId === item.id} onOpen={() => setOpenId(item.id)} />
          ))}
        </ul>
      </section>

      <section className="max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <h3 className="font-semibold">따로 설치</h3>
        <ul className="mt-3 grid gap-2">
          {(doc?.catalog.later_streams ?? []).map((item) => (
            <FeatureRow key={item.id} item={item} open={openId === item.id} onOpen={() => setOpenId(item.id)} />
          ))}
        </ul>
      </section>
    </div>
  );
}
