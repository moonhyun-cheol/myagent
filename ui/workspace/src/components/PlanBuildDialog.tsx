import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Hammer } from '@phosphor-icons/react';
import { fetchPlanBuildPreview, type PickerModel, type PlanBuildPreview, type ReasoningLevel } from '../api/myAgentClient';
import { normalizeReasoningLevelForModel, reasoningSelectOptionsForModel } from '../lib/reasoning-levels';
import { readLastPlanBuildPreference } from '../lib/plan-build';

/**
 * Build = new Agent conversation. The Plan chat usually runs a costlier model, so the
 * build model / reasoning are picked here (prefilled with the last Build choice).
 */
export function PlanBuildDialog(props: {
  sessionId: string;
  modelOptions: PickerModel[];
  currentModel: string;
  currentReasoning: ReasoningLevel;
  onCancel: () => void;
  onConfirm: (choice: { model: string; reasoning: ReasoningLevel }) => Promise<void>;
  /** Ask the Plan chat to restate the full PLAN block (same chat, Plan mode). */
  onReformat: (message: string) => void;
}) {
  const { sessionId, modelOptions, currentModel, currentReasoning, onCancel, onConfirm, onReformat } = props;
  const languageModels = useMemo(
    () => modelOptions.filter((option) => option.category !== 'video'),
    [modelOptions],
  );
  const capabilityFor = (id: string) => languageModels.find((option) => option.id === id)?.reasoning_capability;
  const [model, setModel] = useState(() => {
    const last = readLastPlanBuildPreference();
    if (last && languageModels.some((option) => option.id === last.model)) return last.model;
    return currentModel || 'auto';
  });
  const [reasoning, setReasoning] = useState<ReasoningLevel>(() => {
    const last = readLastPlanBuildPreference();
    const initialModel = last && languageModels.some((option) => option.id === last.model) ? last.model : currentModel;
    const base = last && initialModel === last.model ? last.reasoning : currentReasoning;
    return normalizeReasoningLevelForModel(base, initialModel, capabilityFor(initialModel));
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PlanBuildPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const reasoningOptions = reasoningSelectOptionsForModel(model, { capability: capabilityFor(model) });

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    fetchPlanBuildPreview(sessionId)
      .then((next) => { if (!cancelled) setPreview(next); })
      // Preview is advisory: the handoff itself still validates the PLAN block.
      .catch(() => { if (!cancelled) setPreview(null); })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const blockMissing = preview?.status === 'missing';
  const notBuildable = preview?.status === 'not_buildable';
  const reformatMessage = preview && preview.status !== 'not_buildable' ? preview.reformatMessage : '';
  const buildDisabled = pending || previewLoading || blockMissing || notBuildable;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, pending]);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm({ model, reasoning });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  const selectClass =
    'w-full rounded-lg border border-line bg-ink/45 px-3 py-2 text-sm text-text outline-none focus:border-accent/60';

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-slate-950/45 p-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="plan-build-dialog-title"
      data-testid="plan-build-dialog"
      onClick={() => {
        if (!pending) onCancel();
      }}
    >
      <div
        className="w-full max-w-[440px] overflow-hidden rounded-2xl border border-line/90 bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.55)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-1 w-full bg-accent" aria-hidden />
        <div className="p-6">
          <h2 id="plan-build-dialog-title" className="m-0 flex items-center gap-2 text-[15px] font-semibold text-text">
            <Hammer size={16} weight="bold" />
            새 대화에서 구현
          </h2>
          <p className="mt-2 text-[13px] leading-5 text-muted">
            PLAN 블록과 P0 제약만 새 Agent 대화로 넘깁니다. 구현에 쓸 모델과 추론 수준을 고르세요.
          </p>
          {blockMissing ? (
            <p data-testid="plan-build-block-missing" className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] leading-5 text-text">
              이 답변에는 PLAN 블록이 없어 새 대화로 넘길 내용이 없습니다. 「PLAN으로 정리 요청」을 누르면 이 대화에서 지금까지의 내용을 PLAN 형식으로 다시 받습니다.
            </p>
          ) : preview?.status === 'incomplete' ? (
            <p data-testid="plan-build-incomplete" className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-text">
              PLAN이 불완전합니다. 빠진 항목: {preview.missingFields.join(', ')}. 변경분만 담긴 답변이면 구현 대화가 빠진 내용을 모릅니다. 다시 정리하거나 그대로 Build할 수 있습니다.
            </p>
          ) : notBuildable ? (
            <p data-testid="plan-build-not-buildable" className="mt-3 text-[12px] font-semibold leading-snug text-danger">
              {preview.message}
            </p>
          ) : null}
          <label className="mt-5 block text-[12px] font-semibold text-muted" htmlFor="plan-build-model">
            모델
          </label>
          <select
            id="plan-build-model"
            data-testid="plan-build-model"
            className={`${selectClass} mt-1.5`}
            value={model}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.value;
              setModel(next);
              setReasoning((prev) => normalizeReasoningLevelForModel(prev, next, capabilityFor(next)));
            }}
          >
            {languageModels.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <label className="mt-4 block text-[12px] font-semibold text-muted" htmlFor="plan-build-reasoning">
            추론 수준
          </label>
          <select
            id="plan-build-reasoning"
            data-testid="plan-build-reasoning"
            className={`${selectClass} mt-1.5`}
            value={reasoning}
            disabled={pending || reasoningOptions.length <= 1}
            onChange={(e) => setReasoning(e.target.value as ReasoningLevel)}
          >
            {reasoningOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {error ? (
            <p data-testid="plan-build-error" className="mt-4 text-[12px] font-semibold leading-snug text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              className="min-w-[80px] rounded-xl border border-line bg-panel-2/80 px-3.5 py-2.5 text-xs font-medium text-muted transition-colors hover:border-accent/50 hover:text-text"
              disabled={pending}
              onClick={onCancel}
            >
              취소
            </button>
            {reformatMessage && (blockMissing || preview?.status === 'incomplete') ? (
              <button
                type="button"
                data-testid="plan-build-reformat"
                className="min-w-[96px] rounded-xl border border-accent/60 bg-accent/12 px-3.5 py-2.5 text-xs font-semibold text-accent-dim transition-colors hover:bg-accent/20"
                disabled={pending}
                onClick={() => onReformat(reformatMessage)}
              >
                PLAN으로 정리 요청
              </button>
            ) : null}
            <button
              type="button"
              data-testid="plan-build-confirm"
              autoFocus
              className="min-w-[96px] rounded-xl bg-accent px-3.5 py-2.5 text-xs font-semibold text-ink transition-colors hover:bg-accent/90 disabled:opacity-60"
              disabled={buildDisabled}
              onClick={() => void submit()}
            >
              {pending
                ? '새 대화 여는 중…'
                : previewLoading
                  ? 'PLAN 확인 중…'
                  : preview?.status === 'incomplete'
                    ? '그래도 Build'
                    : '새 대화에서 Build'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
