import { ArrowCounterClockwise, CloudArrowDown, Play } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyWorkKitProfile,
  checkWorkKitCatalog,
  fetchProfiles,
  installWorkKitShelf,
  refreshWorkKitCatalog,
  restoreProfileLastState,
  type AgentProfileApplied,
  type ShelfInstallStatus,
  type WorkKitCatalogGroup,
  type WorkKitShelf,
} from '../api/profilesClient';
import { syncOrganizationModuleIfNeeded } from '../api/organizationModule';
import { confirmDialog } from '../lib/confirmDialog';

interface ProfileLibraryProps {
  onLaunchMyAgent?: () => void;
}

export function ProfileLibrary({ onLaunchMyAgent }: ProfileLibraryProps) {
  const [groups, setGroups] = useState<WorkKitCatalogGroup[]>([]);
  const [feedSequence, setFeedSequence] = useState<number | null>(null);
  const [appliedKits, setAppliedKits] = useState<AgentProfileApplied[]>([]);
  const [canRestore, setCanRestore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('');
  const catalogSyncedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchProfiles();
      setGroups(data.groups);
      setFeedSequence(data.feed_sequence);
      setAppliedKits(Array.isArray(data.applied_kits) ? data.applied_kits : (data.applied ? [data.applied] : []));
      setCanRestore(data.can_restore);
      setSelectedGroup((prev) => {
        if (prev && data.groups.some((g) => g.id === prev)) return prev;
        if (data.applied?.group && data.groups.some((g) => g.id === data.applied!.group)) {
          return data.applied.group;
        }
        return data.groups[0]?.id ?? '';
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '작업 키트 목록을 불러오지 못했습니다.');
    }
  }, []);

  const syncCatalog = useCallback(async (silent = false) => {
    setSyncing(true);
    try {
      const check = await checkWorkKitCatalog();
      if (!check.feed_url) {
        setMessage(
          '작업 키트 목록 피드가 연결되지 않았습니다. MY_AGENT_WORK_KIT_CATALOG_FEED_URL을 설정한 뒤 「목록 새로고침」을 누르세요.',
        );
        await load();
        return;
      }
      if (check.update_available || !check.cached_sequence) {
        await refreshWorkKitCatalog();
        if (!silent) setMessage('작업 키트 목록을 최신으로 가져왔습니다.');
      } else if (!silent) {
        setMessage('카탈로그가 이미 최신입니다.');
      }
      await load();
    } catch (error) {
      const detail = error instanceof Error ? error.message : '카탈로그를 가져오지 못했습니다.';
      setMessage(silent
        ? `목록을 서버에서 가져오지 못했습니다. 「목록 새로고침」을 다시 눌러 주세요. (${detail})`
        : detail);
      await load();
    } finally {
      setSyncing(false);
    }
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (catalogSyncedRef.current) return;
    catalogSyncedRef.current = true;
    void syncCatalog(true);
  }, [syncCatalog]);

  const activeGroupId = groups.some((g) => g.id === selectedGroup)
    ? selectedGroup
    : groups[0]?.id ?? '';
  const active = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? null,
    [groups, activeGroupId],
  );

  const appliedLabel = (() => {
    if (appliedKits.length === 0) return null;
    const labels = appliedKits.map((kit) => {
      if (kit.group && kit.kit_id) {
        const g = groups.find((x) => x.id === kit.group);
        const s = g?.shelves.find((x) => x.id === kit.kit_id);
        return s?.label ?? `${kit.group}/${kit.kit_id}`;
      }
      return kit.profile_id;
    });
    return labels.join(', ');
  })();

  const isKitApplied = (shelf: WorkKitShelf) =>
    appliedKits.some((kit) => kit.group === shelf.group && kit.kit_id === shelf.id);

  const restore = async () => {
    setBusy(true);
    try {
      await restoreProfileLastState();
      setMessage('이전 상태로 되돌렸습니다.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '되돌리기 실패');
    } finally {
      setBusy(false);
    }
  };

  const installKit = async (shelf: WorkKitShelf) => {
    setBusy(true);
    try {
      await installWorkKitShelf(shelf.group, shelf.id);
      setMessage(`「${shelf.label}」 받기를 완료했습니다.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '받기 실패');
    } finally {
      setBusy(false);
    }
  };

  const applyKit = async (shelf: WorkKitShelf) => {
    const ok = await confirmDialog({
      title: '작업 키트 적용',
      message: `「${shelf.label}」로 맞출까요?`,
      confirmLabel: '적용',
      danger: false,
    });
    if (!ok) return;
    setBusy(true);
    try {
      if (shelf.hints?.needs_organization_module) {
        await syncOrganizationModuleIfNeeded();
      }
      const result = await applyWorkKitProfile(shelf.group, shelf.id);
      const warn = result.warnings?.length ? ` (${result.warnings[0]})` : '';
      setMessage(`「${shelf.label}」 적용했습니다.${warn}`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '적용 실패');
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || syncing;

  return (
    <section
      data-testid="work-kit-library"
      className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-line bg-panel shadow-sm"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h1 className="text-lg font-semibold text-text">MY Agent 관리자</h1>
          <p className="mt-0.5 text-sm text-muted">
            사용할 작업 키트를 받고 적용한 뒤 MY Agent를 실행하세요.
          </p>
          {feedSequence != null ? (
            <p className="mt-1 text-[11px] text-muted">카탈로그 seq {feedSequence}</p>
          ) : null}
          {appliedLabel ? (
            <p className="mt-2 text-sm text-text">
              적용 중 · <span className="font-semibold text-accent">{appliedLabel}</span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {onLaunchMyAgent ? (
            <button
              type="button"
              data-testid="launcher-open-my-agent"
              disabled={disabled}
              onClick={onLaunchMyAgent}
              className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Play size={15} weight="fill" />
              MY Agent 실행
            </button>
          ) : null}
          <button
            type="button"
            data-testid="work-kit-catalog-sync"
            disabled={disabled}
            onClick={() => void syncCatalog(false)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-semibold text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            <CloudArrowDown size={15} />
            {syncing ? '가져오는 중…' : '목록 새로고침'}
          </button>
          {canRestore ? (
            <button
              type="button"
              data-testid="work-profile-restore"
              disabled={disabled}
              onClick={() => void restore()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-semibold text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ArrowCounterClockwise size={15} /> 되돌리기
            </button>
          ) : null}
        </div>
      </header>

      {message ? (
        <p
          data-testid="work-profile-message"
          className="mx-5 mt-4 rounded-xl border border-line bg-ink/30 px-3 py-2 text-xs text-muted"
        >
          {message}
        </p>
      ) : null}

      {groups.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted">
          <p>등록된 작업 키트가 없습니다.</p>
          <p className="mt-2 text-xs">「목록 새로고침」으로 카탈로그를 가져오세요.</p>
        </div>
      ) : (
        <div className="flex min-h-[320px]">
          <nav className="w-36 shrink-0 border-r border-line bg-ink/30 p-2 sm:w-44">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                data-testid={`profile-picker-brand-${g.id}`}
                onClick={() => setSelectedGroup(g.id)}
                className={`mb-1 w-full rounded-xl px-3 py-2.5 text-left text-sm font-semibold ${
                  activeGroupId === g.id
                    ? 'bg-accent/15 text-accent'
                    : 'text-text hover:bg-ink'
                }`}
              >
                {g.label}
                <span className="mt-0.5 block text-[10px] font-normal text-muted">
                  {g.shelves.length}개 키트
                </span>
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {!active || active.shelves.length === 0 ? (
              <p className="text-sm text-muted">이 브랜드에 키트가 없습니다.</p>
            ) : (
              <ul className="space-y-3">
                {active.shelves.map((shelf) => (
                  <KitCard
                    key={`${shelf.group}/${shelf.id}`}
                    shelf={shelf}
                    isApplied={isKitApplied(shelf)}
                    disabled={disabled}
                    onInstall={() => void installKit(shelf)}
                    onApply={() => void applyKit(shelf)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function statusLabel(status: ShelfInstallStatus | undefined): string | null {
  switch (status) {
    case 'available': return '받기 가능';
    case 'installed': return '설치됨';
    case 'update_available': return '업데이트 있음';
    case 'missing_asset': return '받기 불가';
    default: return null;
  }
}

function resolveInstallStatus(shelf: WorkKitShelf): ShelfInstallStatus {
  if (shelf.install_status) return shelf.install_status;
  if (shelf.origin === 'catalog') return 'available';
  if (shelf.origin === 'locker') return 'installed';
  return 'available';
}

function KitCard({
  shelf,
  isApplied,
  disabled,
  onInstall,
  onApply,
}: {
  shelf: WorkKitShelf;
  isApplied: boolean;
  disabled: boolean;
  onInstall: () => void;
  onApply: () => void;
}) {
  const status = resolveInstallStatus(shelf);
  const canApply = status === 'installed' || status === 'update_available';
  const needsInstall = status === 'available' || status === 'update_available';
  const statusText = statusLabel(status);

  return (
    <li
      data-testid={`profile-picker-kit-${shelf.group}-${shelf.id}`}
      className={`flex items-start justify-between gap-4 rounded-xl border px-4 py-4 transition-colors ${
        isApplied
          ? 'border-accent/40 bg-accent/5'
          : 'border-line bg-[#fafbf8] hover:border-accent/30'
      }`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold text-text">{shelf.label}</span>
          {statusText ? (
            <span className="rounded-md bg-ink/40 px-2 py-0.5 text-[10px] font-semibold text-muted">
              {statusText}
            </span>
          ) : null}
          {isApplied ? (
            <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
              적용 중
            </span>
          ) : null}
        </div>
        {shelf.description ? (
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{shelf.description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
        {needsInstall ? (
          <button
            type="button"
            data-testid={`profile-picker-install-${shelf.group}-${shelf.id}`}
            disabled={disabled}
            onClick={onInstall}
            className="rounded-xl border border-line bg-panel px-4 py-2 text-sm font-semibold text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            {status === 'update_available' ? '업데이트' : '받기'}
          </button>
        ) : null}
        <button
          type="button"
          data-testid={`profile-picker-apply-${shelf.group}-${shelf.id}`}
          disabled={disabled || isApplied || !canApply}
          onClick={onApply}
          className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isApplied ? '적용됨' : '적용'}
        </button>
      </div>
    </li>
  );
}
