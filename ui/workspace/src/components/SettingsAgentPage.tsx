import { ShieldCheck } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import {
  agentAutopilotModeFromConfig,
  fetchAppConfig,
  fetchApprovalReviewer,
  saveApprovalReviewer,
  testApprovalReviewer,
  type ApprovalReviewerSettings,
  setAgentAutopilot,
  setAgentExecutionPreset,
  setAgentReasoning,
  setApprovalDelegation,
  type AgentAutopilotMode,
  type ReasoningLevel,
} from '../api/myAgentClient';
import { ALL_REASONING_SELECT_OPTIONS } from '../lib/reasoning-levels';

interface SettingsAgentPageProps {
  readOnly: boolean;
  onManageWorkspaces: () => void;
}

export function SettingsAgentPage({ readOnly, onManageWorkspaces }: SettingsAgentPageProps) {
  const [autopilot, setAutopilotMode] = useState<AgentAutopilotMode>('auto');
  const [reasoning, setReasoning] = useState<ReasoningLevel>('auto');
  const [approval, setApprovalMode] = useState<'off' | 'safe_local' | 'auto_review'>('off');
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reviewer, setReviewer] = useState<ApprovalReviewerSettings | null>(null);
  const [reviewerTest, setReviewerTest] = useState('');

  useEffect(() => {
    let active = true;
    void fetchApprovalReviewer()
      .then((settings) => { if (active) setReviewer(settings); })
      .catch(() => { /* older core: section stays hidden */ });
    return () => {
      active = false;
    };
  }, []);

  const saveReviewer = async (patch: { approval_reviewer_model?: string; approval_card_triage?: boolean }) => {
    if (!reviewer) return;
    setBusy(true);
    setMessage('');
    setReviewerTest('');
    try {
      await saveApprovalReviewer(patch);
      setReviewer({
        ...reviewer,
        selected: patch.approval_reviewer_model !== undefined ? (patch.approval_reviewer_model || reviewer.default) : reviewer.selected,
        card_triage: patch.approval_card_triage ?? reviewer.card_triage,
      });
      setMessage('판단 모델 설정을 저장했습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '판단 모델 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  const runReviewerTest = async () => {
    if (!reviewer) return;
    setBusy(true);
    setReviewerTest('테스트 중…');
    try {
      const result = await testApprovalReviewer(reviewer.selected);
      setReviewerTest(
        result.reviewer === 'unavailable' || result.reviewer === 'policy'
          ? `연결 실패 — ${result.reason}`
          : `${result.decision === 'allow' ? '정상 (허용 판단)' : '응답은 왔지만 보류 판단'} · ${result.reviewer} · ${(result.duration_ms / 1000).toFixed(1)}초 — ${result.reason}`,
      );
    } catch (error) {
      setReviewerTest(error instanceof Error ? error.message : '테스트 실패');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    void fetchAppConfig()
      .then((config) => {
        if (!active) return;
        setAutopilotMode(agentAutopilotModeFromConfig(config.agent_autopilot));
        setReasoning(config.agent_reasoning ?? 'auto');
        setApprovalMode(config.approval_delegation ?? 'off');
        setWorkspaceRoot(config.dev_workspace_root?.trim() || null);
      })
      .catch((error) => {
        if (active) setMessage(error instanceof Error ? error.message : '설정을 불러오지 못했습니다.');
      });
    return () => {
      active = false;
    };
  }, []);

  const saveAutopilot = async (mode: AgentAutopilotMode) => {
    setBusy(true);
    setMessage('');
    try {
      await setAgentAutopilot(mode);
      setAutopilotMode(mode);
      setMessage('Autopilot 설정을 저장했습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Autopilot 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  const saveApproval = async (mode: 'off' | 'safe_local' | 'auto_review') => {
    setBusy(true);
    setMessage('');
    try {
      await setApprovalDelegation(mode);
      setApprovalMode(mode);
      setMessage('승인 처리 설정을 저장했습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '승인 설정 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  const saveReasoning = async (level: ReasoningLevel) => {
    setBusy(true);
    setMessage('');
    try {
      await setAgentReasoning(level);
      setReasoning(level);
      setMessage('새 채팅의 추론 기본값을 저장했습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '추론 기본값 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  const enableDelegatePreset = async () => {
    setBusy(true);
    setMessage('');
    try {
      await setAgentExecutionPreset();
      setAutopilotMode('on');
      setApprovalMode('auto_review');
      setMessage('나 대신 진행을 켰습니다. 연속 실행과 Responses Auto Review가 함께 적용됩니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '나 대신 진행 설정 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">동작·승인</h2>
        <p className="mt-1 text-sm text-muted">새 채팅의 동작 기본값과 PC·워크스페이스 승인 정책을 관리합니다.</p>
      </header>

      {message ? <p className="mb-6 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">{message}</p> : null}

      <div className="max-w-3xl space-y-6">
        <section className="space-y-5">
          <div>
            <h3 className="font-medium">자동화</h3>
            <p className="mt-1 text-sm text-muted">새 채팅을 만들 때 복사할 실행 기본값입니다. 기존 채팅에는 영향을 주지 않습니다.</p>
          </div>

          <div className="rounded-2xl border border-accent/35 bg-accent/5 p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={21} className="text-accent" />
                  <h4 className="font-semibold">나 대신 진행</h4>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted">작업을 연속 실행하고, 안전한 워크스페이스 파일 변경은 Responses Auto Review가 대신 검토합니다.</p>
                <p className="mt-1 text-xs text-muted">외부 쓰기·삭제·터미널·Office 파일은 계속 직접 승인이 필요합니다.</p>
              </div>
              <button
                type="button"
                data-testid="settings-delegate-preset"
                disabled={busy || readOnly || (autopilot === 'on' && approval === 'auto_review')}
                onClick={() => void enableDelegatePreset()}
                className="shrink-0 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-55"
              >
                {autopilot === 'on' && approval === 'auto_review' ? '사용 중' : '나 대신 진행 켜기'}
              </button>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
              <h4 className="font-semibold">추론 수준</h4>
              <p className="mb-4 mt-1 text-xs text-muted">기본값입니다. 채팅에서는 선택한 모델이 지원하는 수준만 보입니다.</p>
              <select
                data-testid="settings-reasoning-level"
                value={
                  ALL_REASONING_SELECT_OPTIONS.some((o) => o.value === reasoning) ? reasoning : 'auto'
                }
                disabled={busy || readOnly}
                onChange={(event) => void saveReasoning(event.target.value as ReasoningLevel)}
                className="w-full rounded-xl border border-line bg-[#fafbf8] px-3 py-2.5 text-sm outline-none focus:border-accent"
              >
                {ALL_REASONING_SELECT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
              <h4 className="font-semibold">Autopilot</h4>
              <p className="mb-4 mt-1 text-xs text-muted">한 작업 안에서 조사·수정·검증을 이어갈 범위</p>
              <select
                data-testid="settings-autopilot-mode"
                value={autopilot}
                disabled={busy || readOnly}
                onChange={(event) => void saveAutopilot(event.target.value as AgentAutopilotMode)}
                className="w-full rounded-xl border border-line bg-[#fafbf8] px-3 py-2.5 text-sm outline-none focus:border-accent"
              >
                <option value="off">수동</option>
                <option value="auto">자동 — 코딩·UI 작업</option>
                <option value="on">연속 실행</option>
              </select>
            </div>
          </div>
        </section>

        <section className="space-y-5 border-t border-line pt-6">
          <div>
            <h3 className="font-medium">승인 위임</h3>
            <p className="mt-1 text-sm text-muted">PC와 활성 워크스페이스에 적용되는 도구 승인 정책입니다.</p>
          </div>

          <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-3">
              <ShieldCheck size={22} className="text-accent" />
              <div>
                <h4 className="font-semibold">승인 처리</h4>
                <p className="mt-0.5 text-xs text-muted">도구 실행 전에 사용할 승인 정책</p>
              </div>
            </div>
            <select
              data-testid="settings-approval-delegation-mode"
              value={approval}
              disabled={busy || readOnly}
              onChange={(event) => void saveApproval(event.target.value as 'off' | 'safe_local' | 'auto_review')}
              className="w-full rounded-xl border border-line bg-[#fafbf8] px-3 py-2.5 text-sm outline-none focus:border-accent"
            >
              <option value="off">매번 승인</option>
              <option value="safe_local">안전한 로컬 쓰기 자동 승인</option>
              <option value="auto_review">나 대신 승인 — 판단 모델 검토</option>
            </select>
            <p className="mt-3 text-sm leading-6 text-muted">아래에서 고른 판단 모델이 작업 의도와 위험을 검토합니다. 작업에 필요한 외부 읽기와 안전한 터미널 실행은 대신 승인할 수 있으며, 외부 쓰기·삭제·롤백·플러그인 변경·Office 원본 변경·NAS 수정은 항상 사용자에게 묻습니다.</p>
          </div>

          {reviewer ? (
            <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm" data-testid="settings-approval-reviewer">
              <h4 className="font-semibold">판단 모델</h4>
              <p className="mb-4 mt-1 text-xs text-muted">승인 여부를 판단할 모델입니다. 고른 모델이 응답하지 않으면 기본 모델이 대신 판단합니다.</p>
              <div className="flex gap-2">
                <select
                  data-testid="settings-approval-reviewer-model"
                  value={reviewer.selected}
                  disabled={busy || readOnly}
                  onChange={(event) => void saveReviewer({ approval_reviewer_model: event.target.value })}
                  className="min-w-0 flex-1 rounded-xl border border-line bg-[#fafbf8] px-3 py-2.5 text-sm outline-none focus:border-accent"
                >
                  {reviewer.candidates.map((c) => (
                    <option key={c.value} value={c.value}>{c.label} — {c.note}</option>
                  ))}
                  {reviewer.candidates.some((c) => c.value === reviewer.selected) ? null : (
                    <option value={reviewer.selected}>{reviewer.selected}</option>
                  )}
                </select>
                <button
                  type="button"
                  data-testid="settings-approval-reviewer-test"
                  disabled={busy}
                  onClick={() => void runReviewerTest()}
                  className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs text-muted hover:border-accent/50 hover:text-text disabled:opacity-55"
                >
                  테스트
                </button>
                <button
                  type="button"
                  data-testid="settings-approval-reviewer-reset"
                  disabled={busy || readOnly || reviewer.selected === reviewer.default}
                  onClick={() => void saveReviewer({ approval_reviewer_model: '' })}
                  className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs text-muted hover:border-accent/50 hover:text-text disabled:opacity-55"
                >
                  기본값
                </button>
              </div>
              {reviewerTest ? <p className="mt-2 text-xs leading-5 text-muted" data-testid="settings-approval-reviewer-test-result">{reviewerTest}</p> : null}
              <label className="mt-4 flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  data-testid="settings-approval-card-triage"
                  checked={reviewer.card_triage}
                  disabled={busy || readOnly}
                  onChange={(event) => void saveReviewer({ approval_card_triage: event.target.checked })}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">매번 승인에서도 카드 선별</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted">나 대신 승인이 꺼져 있을 때, 요청한 작업이 분명하고 되돌릴 수 있는 작업이면 판단 모델이 승인 카드를 생략합니다. 애매하면 카드가 뜹니다.</span>
                </span>
              </label>
              <p className="mt-3 text-xs leading-5 text-muted">판단 모델이 승인한 파일 수정은 실행 전에 되돌리기 지점을 저장합니다. 모델을 바꿔도 이전 되돌리기 지점은 그대로 남습니다.</p>
            </div>
          ) : null}

          <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h4 className="font-semibold">승인 대상 작업 폴더</h4>
                <p className="mt-1 text-xs leading-5 text-muted">현재 활성 워크스페이스가 안전한 로컬 쓰기 및 승인 위임의 기준입니다.</p>
                <p className="mt-3 truncate rounded-lg bg-ink px-3 py-2 font-mono text-xs text-muted" title={workspaceRoot ?? undefined}>
                  {workspaceRoot ?? '선택된 작업 폴더 없음'}
                </p>
              </div>
              <button
                type="button"
                onClick={onManageWorkspaces}
                className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs text-muted hover:border-accent/50 hover:text-text"
              >
                관리
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
