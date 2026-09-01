import { ArrowCounterClockwise, SquaresFour, UserList } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import {
  applyWorkKitProfile,
  fetchProfiles,
  restoreProfileLastState,
  type AgentProfileApplied,
  type WorkKitCatalogGroup,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';
import { ProfilePickerModal } from './ProfilePickerModal';

interface SettingsProfilesSectionProps {
  readOnly: boolean;
  onApplied?: () => void;
}

/**
 * Brand work kits — pick a scene (브랜드 정보 / 제품개발), not org module install.
 */
export function SettingsProfilesSection({ readOnly, onApplied }: SettingsProfilesSectionProps) {
  const [groups, setGroups] = useState<WorkKitCatalogGroup[]>([]);
  const [applied, setApplied] = useState<AgentProfileApplied | null>(null);
  const [canRestore, setCanRestore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchProfiles();
      setGroups(data.groups);
      setApplied(data.applied);
      setCanRestore(data.can_restore);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '작업 환경 목록을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async () => {
    setBusy(true);
    try {
      const result = await restoreProfileLastState();
      setMessage(`이전 상태로 되돌렸습니다. (플러그인 ${result.toggled.length}개 변경)`);
      await load();
      onApplied?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '되돌리기 실패');
    } finally {
      setBusy(false);
    }
  };

  const appliedLabel = (() => {
    if (!applied) return null;
    if (applied.group && applied.kit_id) {
      const g = groups.find((x) => x.id === applied.group);
      const s = g?.shelves.find((x) => x.id === applied.kit_id);
      return s?.label ?? `${applied.group}/${applied.kit_id}`;
    }
    return applied.profile_id;
  })();

  return (
    <section
      data-testid="work-profiles-section"
      className="mb-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <UserList size={21} className="text-accent" />
          <div>
            <h3 className="font-semibold">작업 환경</h3>
            <p className="mt-0.5 text-xs text-muted">
              브랜드와 할 일(브랜드 정보, 제품개발 등)을 고르면 스킬·플러그인이 맞춰집니다.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {canRestore ? (
            <button
              type="button"
              data-testid="work-profile-restore"
              disabled={readOnly || busy}
              onClick={() => void restore()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-semibold text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ArrowCounterClockwise size={15} /> 되돌리기
            </button>
          ) : null}
          <button
            type="button"
            data-testid="work-profile-open-picker"
            disabled={readOnly || busy}
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <SquaresFour size={15} /> 선택
          </button>
        </div>
      </div>

      {message ? (
        <p data-testid="work-profile-message" className="mb-3 rounded-xl border border-line bg-ink/30 px-3 py-2 text-xs text-muted">
          {message}
        </p>
      ) : null}

      {appliedLabel ? (
        <p className="text-sm text-text">
          지금 적용 중: <span className="font-semibold text-accent">{appliedLabel}</span>
        </p>
      ) : (
        <p className="text-sm text-muted">아직 작업 환경을 고르지 않았습니다. 「선택」을 눌러 CQR 등 브랜드와 키트를 고르세요.</p>
      )}

      <ProfilePickerModal
        open={pickerOpen}
        readOnly={readOnly}
        groups={groups}
        applied={applied}
        onClose={() => setPickerOpen(false)}
        onApply={async (group, id) => {
          const g = groups.find((x) => x.id === group);
          const shelf = g?.shelves.find((x) => x.id === id);
          const ok = await confirmDialog({
            title: '작업 환경 적용',
            message: `「${shelf?.label ?? id}」로 맞출까요?`,
            confirmLabel: '적용',
          });
          if (!ok) return;
          setBusy(true);
          try {
            const result = await applyWorkKitProfile(group, id);
            void result;
            setMessage(`「${shelf?.label ?? id}」 적용했습니다.`);
            setPickerOpen(false);
            await load();
            onApplied?.();
          } catch (error) {
            setMessage(error instanceof Error ? error.message : '적용 실패');
          } finally {
            setBusy(false);
          }
        }}
      />
    </section>
  );
}
