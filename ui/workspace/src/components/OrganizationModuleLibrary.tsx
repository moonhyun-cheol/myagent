import { ArrowClockwise, CheckCircle, CloudArrowDown, Package } from '@phosphor-icons/react';
import type {
  OrganizationModuleComponent,
  OrganizationModuleStatus,
  OrganizationModuleUpdate,
} from '../api/myAgentClient';

const COMPONENT_LABELS: Record<string, string> = {
  skills: '스킬',
  'brand-context': '브랜드 컨텍스트',
  'research-pipeline': '리서치 파이프라인',
  'brand-knowledge': '브랜드 지식',
  'automaton-routing': '오토마톤 라우팅',
};

function components(installed: NonNullable<OrganizationModuleStatus['installed']>): OrganizationModuleComponent[] {
  if (installed.components?.length) return installed.components;
  return (installed.capabilities ?? []).map((id) => ({ id, version: installed.version }));
}

interface OrganizationModuleLibraryProps {
  readOnly: boolean;
  busy: boolean;
  checking: boolean;
  status: OrganizationModuleStatus | null;
  pending: OrganizationModuleUpdate | null;
  onRefreshCatalog: () => void;
  onInstallOrUpdate: () => void;
}

export function OrganizationModuleLibrary({
  readOnly,
  busy,
  checking,
  status,
  pending,
  onRefreshCatalog,
  onInstallOrUpdate,
}: OrganizationModuleLibraryProps) {
  const installed = status?.installed ?? null;
  const canRemote = status?.can_check_remote === true;
  const installedList = installed ? components(installed) : [];

  const primaryLabel = (() => {
    if (checking) return '확인 중…';
    if (pending?.first_install) return `${pending.version} 받기`;
    if (pending) return `${pending.version}으로 업데이트`;
    if (installed) return '최신 버전';
    if (!canRemote) return '받을 수 없음';
    return '받기';
  })();

  const statusLine = (() => {
    if (checking) return '서버에서 받을 수 있는지 확인하고 있습니다.';
    if (pending?.first_install) return `버전 ${pending.version} · 받기만 누르면 설치됩니다.`;
    if (pending) return `새 버전 ${pending.version} · 업데이트를 누르면 자동으로 받습니다.`;
    if (installed) return `설치됨 · ${installed.version} (업데이트 ${installed.update_sequence})`;
    if (!canRemote) return '이 PC에서 조직 모듈을 받을 수 없습니다. 관리자에게 문의하세요.';
    return '아직 라이브러리에 없습니다. 받기를 누르면 자동으로 설치됩니다.';
  })();

  const primaryDisabled =
    readOnly
    || busy
    || checking
    || !canRemote
    || (!pending && Boolean(installed));

  return (
    <section
      data-testid="organization-module-library"
      className="mb-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">조직 모듈</h3>
          <p className="mt-0.5 text-xs text-muted">
            회사에서 제공하는 기능 묶음입니다. 스팀처럼 라이브러리에서 받기만 하면 됩니다.
          </p>
        </div>
        <button
          type="button"
          data-testid="organization-module-refresh"
          disabled={busy || checking || !canRemote}
          onClick={onRefreshCatalog}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-semibold text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
        >
          <ArrowClockwise size={15} className={checking ? 'animate-spin' : ''} />
          새로고침
        </button>
      </div>

      <article
        data-testid="organization-module-card"
        className="overflow-hidden rounded-2xl border border-line bg-[#fafbf8]"
      >
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              {installed ? <CheckCircle size={26} weight="fill" /> : <Package size={26} />}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-base font-semibold text-text">CQR 회사 모듈</h4>
                {installed ? (
                  <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                    라이브러리에 있음
                  </span>
                ) : (
                  <span className="rounded-md bg-ink px-2 py-0.5 text-[10px] font-medium text-muted">
                    미설치
                  </span>
                )}
              </div>
              <p data-testid="organization-module-status-line" className="mt-1 text-sm text-muted">
                {statusLine}
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid={pending?.first_install ? 'organization-module-install' : 'organization-module-apply'}
            disabled={primaryDisabled}
            onClick={onInstallOrUpdate}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {!installed || pending ? <CloudArrowDown size={18} /> : <CheckCircle size={18} />}
            {primaryLabel}
          </button>
        </div>

        {installedList.length > 0 ? (
          <div
            data-testid="organization-module-components"
            className="border-t border-line bg-panel/60 px-4 py-3"
          >
            <p className="mb-2 text-[11px] font-semibold tracking-wide text-muted">포함 기능</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {installedList.map((item) => (
                <li
                  key={item.id}
                  data-testid={`organization-module-component-${item.id}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-line bg-ink/30 px-3 py-2"
                >
                  <span className="text-sm text-text">{COMPONENT_LABELS[item.id] ?? item.id}</span>
                  <span className="text-xs text-muted">{item.version}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </article>
    </section>
  );
}
