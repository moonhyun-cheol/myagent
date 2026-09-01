import { ArrowCounterClockwise, UserList } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import {
  applyProfile,
  deleteProfile,
  fetchProfiles,
  listAgentPlugins,
  restoreProfileLastState,
  saveProfile,
  type AgentProfile,
  type AgentProfileApplied,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';

interface SettingsProfilesSectionProps {
  readOnly: boolean;
}

/**
 * 작업 프로필 (data/profile/{id}.json) — 로컬 프리셋.
 * 조직모듈 ZIP(서명 배포)과 별개: 플러그인 enable 묶음 + 스킬 핀/기본값을 한 번에 적용.
 */
export function SettingsProfilesSection({ readOnly }: SettingsProfilesSectionProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [applied, setApplied] = useState<AgentProfileApplied | null>(null);
  const [canRestore, setCanRestore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await fetchProfiles();
      setProfiles(data.profiles);
      setApplied(data.applied);
      setCanRestore(data.can_restore);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '프로필 목록을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (profile: AgentProfile) => {
    const count = Object.keys(profile.plugins?.enable ?? {}).length;
    const ok = await confirmDialog({
      title: '프로필 적용',
      message: `「${profile.label}」 프로필을 적용합니다. 플러그인 ${count}개의 사용 상태가 일괄 변경됩니다. 적용 직전 상태는 자동 저장되어 되돌릴 수 있습니다.`,
      confirmLabel: '적용',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await applyProfile(profile.id);
      const warn = result.warnings.length ? ` · 누락 ${result.warnings.length}건: ${result.warnings.join(', ')}` : '';
      setMessage(`「${profile.label}」 적용됨 — 플러그인 ${result.toggled.length}개 변경${warn}`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '프로필 적용 실패');
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      const result = await restoreProfileLastState();
      setMessage(`이전 상태로 되돌림 — 플러그인 ${result.toggled.length}개 변경`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '되돌리기 실패');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profile: AgentProfile) => {
    const ok = await confirmDialog({
      title: '프로필 삭제',
      message: `「${profile.label}」 프로필을 삭제할까요? 이미 적용된 플러그인 상태는 바뀌지 않습니다.`,
      danger: true,
      confirmLabel: '삭제',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteProfile(profile.id);
      setMessage(`「${profile.label}」 삭제됨`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '프로필 삭제 실패');
    } finally {
      setBusy(false);
    }
  };

  const saveCurrent = async () => {
    const id = newId.trim();
    const label = newLabel.trim() || id;
    if (!id) {
      setMessage('프로필 ID를 입력하세요. (예: product-dev)');
      return;
    }
    setBusy(true);
    try {
      const { plugins } = await listAgentPlugins();
      const enable: Record<string, boolean> = {};
      for (const plugin of plugins) enable[plugin.id] = plugin.enabled;
      await saveProfile({ id, label, plugins: { enable } });
      setMessage(`「${label}」 저장됨 — 현재 플러그인 ${plugins.length}개 상태를 캡처했습니다.`);
      setNewId('');
      setNewLabel('');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '프로필 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="work-profiles-section"
      className="mb-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <UserList size={21} className="text-accent" />
          <div>
            <h3 className="font-semibold">작업 프로필</h3>
            <p className="mt-0.5 text-xs text-muted">
              미리 저장해 둔 스킬·플러그인 조합을 클릭 한 번에 적용합니다. 조직 모듈과는 별개의 로컬 프리셋입니다.
            </p>
          </div>
        </div>
        {canRestore ? (
          <button
            type="button"
            data-testid="work-profile-restore"
            disabled={readOnly || busy}
            onClick={() => void restore()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-semibold text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            <ArrowCounterClockwise size={15} /> 적용 전으로 되돌리기
          </button>
        ) : null}
      </div>

      {message ? (
        <p data-testid="work-profile-message" className="mb-3 rounded-xl border border-line bg-ink/30 px-3 py-2 text-xs text-muted">
          {message}
        </p>
      ) : null}

      {profiles.length > 0 ? (
        <ul className="mb-4 overflow-hidden rounded-xl border border-line bg-[#fafbf8]">
          {profiles.map((profile) => (
            <li
              key={profile.id}
              data-testid={`work-profile-${profile.id}`}
              className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5 first:border-t-0"
            >
              <span className="min-w-0">
                <span className="text-sm font-medium text-text">{profile.label}</span>
                <span className="ml-2 font-mono text-[11px] text-muted">{profile.id}</span>
                {applied?.profile_id === profile.id ? (
                  <span className="ml-2 rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent">적용됨</span>
                ) : null}
                {profile.description ? (
                  <span className="mt-0.5 block text-xs text-muted">{profile.description}</span>
                ) : null}
                <span className="mt-0.5 block text-[11px] text-muted">
                  플러그인 {Object.keys(profile.plugins?.enable ?? {}).length}개
                  {profile.ui?.default_skill_mode ? ` · 기본 스킬 ${profile.ui.default_skill_mode}` : ''}
                  {profile.ui?.pinned_skill_ids?.length ? ` · 핀 ${profile.ui.pinned_skill_ids.length}개` : ''}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                <button
                  type="button"
                  data-testid={`work-profile-apply-${profile.id}`}
                  disabled={readOnly || busy}
                  onClick={() => void apply(profile)}
                  className="rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  적용
                </button>
                <button
                  type="button"
                  data-testid={`work-profile-delete-${profile.id}`}
                  disabled={readOnly || busy}
                  onClick={() => void remove(profile)}
                  className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-text hover:border-red-400 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  삭제
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-muted">저장된 프로필이 없습니다. 아래에서 현재 설정을 프로필로 저장해 보세요.</p>
      )}

      <div className="flex gap-2">
        <input
          data-testid="work-profile-new-id"
          value={newId}
          disabled={readOnly || busy}
          onChange={(event) => setNewId(event.target.value)}
          placeholder="프로필 ID (예: product-dev)"
          className="w-44 rounded-xl border border-line bg-[#fafbf8] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent disabled:opacity-50"
        />
        <input
          data-testid="work-profile-new-label"
          value={newLabel}
          disabled={readOnly || busy}
          onChange={(event) => setNewLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void saveCurrent();
          }}
          placeholder="표시 이름 (예: 상품개발 프로필)"
          className="min-w-0 flex-1 rounded-xl border border-line bg-[#fafbf8] px-3 py-2.5 text-sm outline-none focus:border-accent disabled:opacity-50"
        />
        <button
          type="button"
          data-testid="work-profile-save-current"
          disabled={readOnly || busy || !newId.trim()}
          onClick={() => void saveCurrent()}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
        >
          현재 설정을 프로필로 저장
        </button>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted">
        저장 시 현재 플러그인 사용 상태를 캡처합니다. 적용은 프로필에 명시된 플러그인만 토글하며, 위험(write/network) 플러그인의 승인 절차는 그대로 유지됩니다.
      </p>
    </section>
  );
}
