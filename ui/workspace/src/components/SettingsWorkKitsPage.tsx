import { ArrowCounterClockwise, CloudArrowDown } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyOrganizationModule,
  applyWorkKitProfile,
  checkOrganizationModule,
  checkWorkKitCatalog,
  fetchOrganizationModule,
  fetchProfiles,
  installWorkKitShelf,
  refreshWorkKitCatalog,
  restoreProfileLastState,
  unapplyWorkKitProfile,
  uninstallWorkKitShelf,
  type AgentProfileApplied,
  type OrganizationFeatureStatus,
  type ShelfInstallStatus,
  type WorkKitCatalogGroup,
  type WorkKitShelf,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';

export function SettingsWorkKitsPage({ readOnly }: { readOnly: boolean }) {
  const [groups, setGroups] = useState<WorkKitCatalogGroup[]>([]);
  const [feedSequence, setFeedSequence] = useState<number | null>(null);
  const [appliedKits, setAppliedKits] = useState<AgentProfileApplied[]>([]);
  const [features, setFeatures] = useState<OrganizationFeatureStatus[]>([]);
  const [canRestore, setCanRestore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('');
  const catalogSynced = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchProfiles();
      setGroups(data.groups);
      setFeedSequence(data.feed_sequence);
      setAppliedKits(data.applied_kits);
      setFeatures(data.organization_features);
      setCanRestore(data.can_restore);
      setSelectedGroup((previous) => {
        if (previous && data.groups.some((group) => group.id === previous)) return previous;
        const appliedGroup = data.applied_kits.find((kit) => kit.group)?.group;
        return (appliedGroup && data.groups.some((group) => group.id === appliedGroup))
          ? appliedGroup
          : data.groups[0]?.id ?? '';
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
        setMessage('작업 키트 카탈로그 피드가 연결되지 않았습니다.');
      } else if (check.update_available || !check.cached_sequence) {
        await refreshWorkKitCatalog();
        if (!silent) setMessage('작업 키트 목록을 최신으로 가져왔습니다.');
      } else if (!silent) {
        setMessage('작업 키트 목록이 이미 최신입니다.');
      }
      await load();
    } catch (error) {
      const detail = error instanceof Error ? error.message : '카탈로그를 가져오지 못했습니다.';
      setMessage(silent ? `목록 자동 확인 실패. 「목록 새로고침」을 눌러 다시 시도하세요. (${detail})` : detail);
      await load();
    } finally {
      setSyncing(false);
    }
  }, [load]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (catalogSynced.current) return;
    catalogSynced.current = true;
    void syncCatalog(true);
  }, [syncCatalog]);

  const activeGroupId = groups.some((group) => group.id === selectedGroup)
    ? selectedGroup
    : groups[0]?.id ?? '';
  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? null,
    [activeGroupId, groups],
  );
  const disabled = readOnly || busy || syncing;
  const isApplied = (shelf: WorkKitShelf) => appliedKits.some(
    (kit) => kit.group === shelf.group && kit.kit_id === shelf.id,
  );
  const appliedLabel = appliedKits.map((kit) => {
    const group = groups.find((entry) => entry.id === kit.group);
    return group?.shelves.find((shelf) => shelf.id === kit.kit_id)?.label ?? kit.profile_id;
  }).join(', ');

  const syncOrganizationModule = async () => {
    const status = await fetchOrganizationModule();
    if (status.can_check_remote !== true) return;
    const update = await checkOrganizationModule();
    if (update) await applyOrganizationModule();
  };

  const install = async (shelf: WorkKitShelf) => {
    setBusy(true);
    try {
      await installWorkKitShelf(shelf.group, shelf.id);
      setMessage(`「${shelf.label}」 받기를 완료했습니다.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '받기 실패');
    } finally { setBusy(false); }
  };

  const apply = async (shelf: WorkKitShelf) => {
    if (isApplied(shelf)) return;
    const accepted = await confirmDialog({
      title: '작업 키트 적용',
      message: `「${shelf.label}」를 적용할까요? 기존에 적용한 키트는 유지됩니다.`,
      confirmLabel: '적용',
      danger: false,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      if (shelf.hints?.needs_organization_module) {
        try {
          await syncOrganizationModule();
        } catch (error) {
          const detail = error instanceof Error ? error.message : '알 수 없는 오류';
          throw new Error(`조직 모듈 동기화 실패: ${detail}`);
        }
      }
      const result = await applyWorkKitProfile(shelf.group, shelf.id);
      const featureNote = result.enabled_features?.length ? ` · 추가 기능 활성 ${result.enabled_features.length}` : '';
      const warningNote = result.warnings?.length ? ` · 경고: ${result.warnings.join(' / ')}` : '';
      setMessage(`「${shelf.label}」 적용 완료${featureNote}${warningNote}`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '적용 실패');
    } finally { setBusy(false); }
  };

  const unapply = async (shelf: WorkKitShelf) => {
    const accepted = await confirmDialog({
      title: '적용 해제',
      message: `「${shelf.label}」 적용을 해제할까요? 이 키트만 쓰는 플러그인·추가 기능은 꺼지고 설치 파일은 남습니다.`,
      confirmLabel: '적용 해제',
      danger: true,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      const result = await unapplyWorkKitProfile(shelf.group, shelf.id);
      const warningNote = result.warnings?.length ? ` · 경고: ${result.warnings.join(' / ')}` : '';
      setMessage(`「${shelf.label}」 적용 해제 완료${warningNote}`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '적용 해제 실패');
    } finally { setBusy(false); }
  };

  const removeInstall = async (shelf: WorkKitShelf) => {
    const accepted = await confirmDialog({
      title: '설치 파일 삭제',
      message: `「${shelf.label}」의 로컬 설치 파일을 삭제할까요? 다시 쓰려면 받아야 합니다.`,
      confirmLabel: '삭제',
      danger: true,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await uninstallWorkKitShelf(shelf.group, shelf.id);
      setMessage(`「${shelf.label}」 설치 파일을 삭제했습니다.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '설치 파일 삭제 실패');
    } finally { setBusy(false); }
  };

  const restore = async () => {
    const accepted = await confirmDialog({
      title: '직전 작업 취소',
      message: '마지막 적용 또는 적용 해제 직전의 플러그인·키트·추가 기능 상태로 복원할까요?',
      confirmLabel: '직전 상태로',
      danger: false,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await restoreProfileLastState();
      setMessage('직전 적용/해제 전 상태로 복원했습니다.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '직전 상태 복원 실패');
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7" data-testid="work-kit-library">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3 pr-12">
        <div>
          <h2 className="text-xl font-semibold">작업 키트</h2>
          <p className="mt-1 text-sm text-muted">설정에서 작업 키트를 받고 적용합니다. MY Agent 관리자 프로그램은 더 이상 사용하지 않습니다.</p>
          {feedSequence != null ? <p className="mt-1 text-[11px] text-muted">카탈로그 seq {feedSequence}</p> : null}
          <p className="mt-2 text-sm text-muted">{appliedLabel ? <>적용 중 · <span className="font-semibold text-accent">{appliedLabel}</span></> : '적용 중인 키트 없음'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="work-kit-catalog-sync" disabled={disabled} onClick={() => void syncCatalog(false)} className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-panel px-3 py-2 text-xs font-semibold text-text hover:border-accent disabled:opacity-45">
            <CloudArrowDown size={15} /> {syncing ? '가져오는 중…' : '목록 새로고침'}
          </button>
          {canRestore ? <button type="button" data-testid="work-profile-restore" disabled={disabled} onClick={() => void restore()} className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-panel px-3 py-2 text-xs font-semibold text-text hover:border-accent disabled:opacity-45"><ArrowCounterClockwise size={15} /> 직전 작업 취소</button> : null}
        </div>
      </header>

      {message ? <p data-testid="work-profile-message" className="mb-4 max-w-4xl rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">{message}</p> : null}

      {groups.length === 0 ? (
        <div className="max-w-4xl rounded-2xl border border-dashed border-line px-5 py-8 text-center text-sm text-muted">등록된 작업 키트가 없습니다. 「목록 새로고침」으로 카탈로그를 가져오세요.</div>
      ) : (
        <section className="flex min-h-[360px] max-w-5xl overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
          <nav className="w-40 shrink-0 border-r border-line bg-ink/50 p-2" aria-label="작업 키트 그룹">
            {groups.map((group) => <button key={group.id} type="button" data-testid={`profile-picker-brand-${group.id}`} onClick={() => setSelectedGroup(group.id)} className={`mb-1 w-full rounded-xl px-3 py-2.5 text-left text-sm font-semibold ${activeGroupId === group.id ? 'bg-accent/15 text-accent' : 'text-text hover:bg-panel'}`}>{group.label}<span className="mt-0.5 block text-[10px] font-normal text-muted">{group.shelves.length}개 키트</span></button>)}
          </nav>
          <div className="min-w-0 flex-1 p-4">
            {!activeGroup?.shelves.length ? <p className="text-sm text-muted">이 그룹에 키트가 없습니다.</p> : <ul className="space-y-3">{activeGroup.shelves.map((shelf) => <KitCard key={`${shelf.group}/${shelf.id}`} shelf={shelf} applied={isApplied(shelf)} features={features} disabled={disabled} onInstall={() => void install(shelf)} onApply={() => void apply(shelf)} onUnapply={() => void unapply(shelf)} onRemove={() => void removeInstall(shelf)} />)}</ul>}
          </div>
        </section>
      )}
    </div>
  );
}

function resolveInstallStatus(shelf: WorkKitShelf): ShelfInstallStatus {
  if (shelf.install_status) return shelf.install_status;
  return shelf.origin === 'locker' ? 'installed' : 'available';
}

function KitCard({ shelf, applied, features, disabled, onInstall, onApply, onUnapply, onRemove }: {
  shelf: WorkKitShelf;
  applied: boolean;
  features: OrganizationFeatureStatus[];
  disabled: boolean;
  onInstall: () => void;
  onApply: () => void;
  onUnapply: () => void;
  onRemove: () => void;
}) {
  const status = resolveInstallStatus(shelf);
  const canApply = status === 'installed' || status === 'update_available';
  const needsInstall = status === 'available' || status === 'update_available';
  const featureBadges = Object.keys(shelf.features?.enable ?? {}).map((id) => {
    const live = features.find((feature) => feature.id === id);
    if (live?.enabled) return { id, label: '추가 기능 활성', className: 'bg-accent/10 text-accent' };
    if (live?.installed) return { id, label: '추가 기능 설치됨(꺼짐)', className: 'bg-amber-500/10 text-amber-600' };
    if (applied) return { id, label: '추가 기능 실패/미설치', className: 'bg-red-500/10 text-red-500' };
    return { id, label: '추가 기능 필요', className: 'bg-ink text-muted' };
  });
  const statusLabel = status === 'available' ? '받기 가능' : status === 'installed' ? '설치됨' : status === 'update_available' ? '업데이트 있음' : '받기 불가';

  return <li data-testid={`profile-picker-kit-${shelf.group}-${shelf.id}`} className={`flex items-start justify-between gap-4 rounded-xl border p-4 ${applied ? 'border-accent/40 bg-accent/5' : 'border-line bg-ink/30'}`}>
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-text">{shelf.label}</span><span className="rounded-md bg-ink px-2 py-0.5 text-[10px] font-semibold text-muted">{statusLabel}</span>{applied ? <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">적용 중</span> : null}{featureBadges.map((badge) => <span key={badge.id} title={badge.id} className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}>{badge.label}</span>)}</div>
      {shelf.description ? <p className="mt-1.5 text-sm leading-relaxed text-muted">{shelf.description}</p> : null}
    </div>
    <div className="flex shrink-0 flex-wrap justify-end gap-2">
      {needsInstall ? <button type="button" data-testid={`profile-picker-install-${shelf.group}-${shelf.id}`} disabled={disabled} onClick={onInstall} className="rounded-xl border border-line px-3 py-2 text-sm font-semibold text-text hover:border-accent disabled:opacity-45">{status === 'update_available' ? '업데이트' : '받기'}</button> : null}
      {applied ? <button type="button" data-testid={`profile-picker-unapply-${shelf.group}-${shelf.id}`} disabled={disabled} onClick={onUnapply} className="rounded-xl border border-red-400/50 px-3 py-2 text-sm font-semibold text-red-500 disabled:opacity-45">적용 해제</button> : <button type="button" data-testid={`profile-picker-apply-${shelf.group}-${shelf.id}`} disabled={disabled || !canApply} onClick={onApply} className="rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-45">적용</button>}
      {!applied && canApply ? <button type="button" data-testid={`profile-picker-uninstall-${shelf.group}-${shelf.id}`} disabled={disabled} onClick={onRemove} className="rounded-xl border border-line px-3 py-2 text-xs font-semibold text-muted hover:border-accent disabled:opacity-45">설치 삭제</button> : null}
    </div>
  </li>;
}
