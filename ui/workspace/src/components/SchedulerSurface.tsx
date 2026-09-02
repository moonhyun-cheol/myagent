import {
  CheckCircle,
  Clock,
  DotsThree,
  Lightning,
  Pause,
  Play,
  Plus,
  Trash,
  UserCircle,
  WarningCircle,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildAutomationTriggers,
  deleteAutomationTask,
  listAutomationRuns,
  listAutomationTasks,
  runAutomationTask,
  saveAutomationTask,
  setAutomationTaskEnabled,
  type AutomationRun,
  type AutomationScheduleMode,
  type AutomationTask,
  type AutomationTaskTrigger,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';
import { useWorkspaceStore } from '../store/workspaceStore';

type SchedulerTab = 'schedules' | 'runs';

function useAutomationWritable(): { canMutate: boolean; readOnlyNotice: string | null } {
  const licenseMode = useWorkspaceStore((s) => s.licenseMode);
  if (licenseMode === 'read_only') {
    return { canMutate: false, readOnlyNotice: '읽기 전용 라이선스 — 자동화 작업을 저장·변경할 수 없습니다.' };
  }
  if (licenseMode && licenseMode !== 'full') {
    return { canMutate: false, readOnlyNotice: '라이선스가 필요합니다 — 자동화 작업을 저장·변경할 수 없습니다.' };
  }
  return { canMutate: true, readOnlyNotice: null };
}

export function SchedulerSurface() {
  const [activeTab, setActiveTab] = useState<SchedulerTab>('schedules');
  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const { canMutate, readOnlyNotice } = useAutomationWritable();

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="자동화">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-7 py-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Feature</p>
          <h1 className="mt-1 text-xl font-semibold text-text">자동화</h1>
          <p className="mt-1 text-sm text-muted">시간이나 동작 조건에 맞춰 개인화된 채팅 작업을 실행합니다.</p>
          {readOnlyNotice ? (
            <p role="status" className="mt-2 text-xs font-medium text-amber-800">{readOnlyNotice}</p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={!canMutate}
          title={canMutate ? undefined : readOnlyNotice ?? '저장할 수 없습니다'}
          onClick={() => {
            setActiveTab('schedules');
            setCreating(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Plus size={14} weight="bold" />
          새 일정
        </button>
      </header>

      <nav className="flex h-11 shrink-0 items-end gap-5 border-b border-line px-7" aria-label="자동화 메뉴">
        <button
          type="button"
          aria-current={activeTab === 'schedules' ? 'page' : undefined}
          onClick={() => setActiveTab('schedules')}
          className={`h-full border-b-2 px-0.5 text-xs font-medium transition ${
            activeTab === 'schedules'
              ? 'border-accent text-text'
              : 'border-transparent text-muted hover:text-text'
          }`}
        >
          일정
        </button>
        <button
          type="button"
          aria-current={activeTab === 'runs' ? 'page' : undefined}
          onClick={() => setActiveTab('runs')}
          className={`h-full border-b-2 px-0.5 text-xs font-medium transition ${
            activeTab === 'runs'
              ? 'border-accent text-text'
              : 'border-transparent text-muted hover:text-text'
          }`}
        >
          실행 기록
        </button>
      </nav>

      <div className="min-h-0 flex-1 overflow-auto px-7 py-6">
        {activeTab === 'schedules' ? (
          creating ? (
            <ScheduleDraft
              canMutate={canMutate}
              readOnlyNotice={readOnlyNotice}
              onCancel={() => setCreating(false)}
              onSaved={() => {
                bumpRefresh();
                setCreating(false);
              }}
            />
          ) : (
            <ScheduleDashboard refreshKey={refreshKey} canMutate={canMutate} onCreate={() => setCreating(true)} onChanged={bumpRefresh} />
          )
        ) : (
          <RunsDashboard refreshKey={refreshKey} />
        )}
      </div>
    </section>
  );
}

type TriggerKind = 'Time' | 'Sequence' | 'On action' | 'Condition' | 'Manual';

type ScheduleRow = {
  id: string;
  name: string;
  description: string;
  triggers: TriggerKind[];
  nextRun: string;
  enabled: boolean;
  status: '활성' | '대기' | '오류';
  statusTone: 'green' | 'amber' | 'blue';
};

const TRIGGER_KIND: Record<AutomationTaskTrigger['type'], TriggerKind> = {
  time: 'Time',
  sequence: 'Sequence',
  on_action: 'On action',
  condition: 'Condition',
  manual: 'Manual',
};

const WEEKDAY_OPTIONS: Array<{ iso: number; label: string }> = [
  { iso: 1, label: '월' },
  { iso: 2, label: '화' },
  { iso: 3, label: '수' },
  { iso: 4, label: '목' },
  { iso: 5, label: '금' },
  { iso: 6, label: '토' },
  { iso: 7, label: '일' },
];

function taskToRow(task: AutomationTask): ScheduleRow {
  return {
    id: task.id,
    name: task.name,
    description: task.description || task.instruction,
    triggers: task.triggers.length > 0
      ? task.triggers.map((trigger) => TRIGGER_KIND[trigger.type])
      : ['Manual'],
    nextRun: task.next_run_at
      ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(task.next_run_at))
      : '수동 실행',
    enabled: task.enabled,
    status: task.enabled ? '활성' : '대기',
    statusTone: task.enabled ? 'green' : 'blue',
  };
}

function countRecentFailedRuns(runs: AutomationRun[]): number {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return runs.filter((run) => {
    if (run.status !== 'failed') return false;
    const stamp = run.finished_at ?? run.started_at ?? run.created_at;
    const at = stamp ? new Date(stamp).getTime() : NaN;
    return Number.isFinite(at) && at >= cutoff;
  }).length;
}

function findNextRunLabel(tasks: AutomationTask[]): { label: string; name: string } {
  const upcoming = tasks
    .filter((task) => task.enabled && task.next_run_at)
    .map((task) => ({ task, at: new Date(task.next_run_at as string).getTime() }))
    .filter((item) => Number.isFinite(item.at))
    .sort((a, b) => a.at - b.at)[0];
  if (!upcoming) return { label: '-', name: '예약 작업 없음' };
  return {
    label: new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(upcoming.at)),
    name: upcoming.task.name,
  };
}

const TRIGGER_META: Record<TriggerKind, { label: string; className: string }> = {
  Time: { label: 'Time', className: 'border-cyan-600 bg-cyan-500 text-slate-950' },
  Sequence: { label: 'Sequence', className: 'border-violet-700 bg-violet-600 text-white' },
  'On action': { label: 'On action', className: 'border-orange-600 bg-orange-500 text-slate-950' },
  Condition: { label: 'Condition', className: 'border-fuchsia-700 bg-fuchsia-600 text-white' },
  Manual: { label: 'Manual', className: 'border-slate-700 bg-slate-600 text-white' },
};

function ScheduleDashboard({
  refreshKey,
  canMutate,
  onCreate,
  onChanged,
}: {
  refreshKey: number;
  canMutate: boolean;
  onCreate: () => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [failedCount, setFailedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    void Promise.all([listAutomationTasks(), listAutomationRuns(100)])
      .then(([nextTasks, runs]) => {
        if (cancelled) return;
        setTasks(nextTasks);
        setRows(nextTasks.map(taskToRow));
        setFailedCount(countRecentFailedRuns(runs));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : '자동화 작업을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const nextRun = useMemo(() => findNextRunLabel(tasks), [tasks]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard label="예약 작업" value={String(rows.length)} detail="등록된 실제 작업" tone="accent" />
        <SummaryCard label="다음 실행" value={nextRun.label} detail={nextRun.name} tone="blue" />
        <SummaryCard
          label="실행 오류"
          value={String(failedCount)}
          detail="최근 7일"
          tone={failedCount > 0 ? 'amber' : 'green'}
        />
      </div>

      <section className="overflow-hidden rounded-2xl border border-line bg-white/80 shadow-[0_8px_28px_rgba(23,33,29,0.08)]">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-white px-5 py-4">
          <div>
            <h2 className="text-[15px] font-bold text-text">자동화 작업</h2>
            <p className="mt-1 text-xs leading-5 text-muted">작업 설명과 실행 조건을 확인하고, 결과는 작업 뉴스피드로 받습니다.</p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="rounded-full border border-line bg-panel px-2.5 py-1 font-medium">실제 작업</span>
            <button
              type="button"
              disabled={!canMutate}
              onClick={onCreate}
              className="inline-flex items-center gap-1.5 rounded-lg border border-accent bg-accent px-3 py-2 font-bold text-white shadow-sm transition hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Plus size={13} weight="bold" />
              작업 추가
            </button>
          </div>
        </div>

        <div className="hidden grid-cols-[minmax(230px,1.45fr)_minmax(190px,1fr)_minmax(180px,0.9fr)_130px_32px] gap-5 border-b border-line bg-panel-2/55 px-5 py-3 text-[11px] font-bold tracking-[0.04em] text-text md:grid">
          <span>작업</span>
          <span>트리거</span>
          <span>다음 실행</span>
          <span>상태</span>
          <span />
        </div>

        <div className="divide-y divide-line/80">
          {loading ? (
            <p className="px-5 py-8 text-center text-xs text-muted">자동화 작업을 불러오는 중입니다.</p>
          ) : loadError ? (
            <p role="alert" className="px-5 py-8 text-center text-xs text-red-700">{loadError}</p>
          ) : rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-muted">등록된 자동화 작업이 없습니다.</p>
          ) : rows.map((row) => (
            <ScheduleTableRow key={row.id} row={row} canMutate={canMutate} onChanged={onChanged} />
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-white/70 px-5 py-4 shadow-[0_4px_18px_rgba(23,33,29,0.05)]">
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-white shadow-sm">
            <Lightning size={16} weight="fill" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-text">트리거 태그 안내</h3>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <TriggerTag kind="Time" />
              <TriggerTag kind="Manual" />
            </div>
            <p className="mt-2.5 text-xs leading-5 text-muted">
              현재는 시간 기반 실행과 수동 실행을 지원합니다. Sequence, On action, Condition 트리거는 다음 업데이트에서 추가됩니다.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'accent' | 'blue' | 'green' | 'amber';
}) {
  const toneClass = tone === 'accent'
    ? 'text-accent-dim'
    : tone === 'blue'
      ? 'text-sky-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : 'text-emerald-700';
  const edgeClass = tone === 'accent'
    ? 'border-l-accent'
    : tone === 'blue'
      ? 'border-l-sky-600'
      : tone === 'amber'
        ? 'border-l-amber-500'
        : 'border-l-emerald-600';
  return (
    <div className={`rounded-xl border border-line border-l-4 bg-white/85 px-5 py-4 shadow-[0_4px_16px_rgba(23,33,29,0.06)] ${edgeClass}`}>
      <p className="text-[11px] font-bold tracking-[0.06em] text-muted">{label}</p>
      <div className="mt-1.5 flex items-baseline gap-2.5">
        <span className={`text-2xl font-bold ${toneClass}`}>{value}</span>
        <span className="truncate text-xs font-medium text-muted">{detail}</span>
      </div>
    </div>
  );
}

function TriggerTag({ kind }: { kind: TriggerKind }) {
  const meta = TRIGGER_META[kind];
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold shadow-sm ${meta.className}`}>{meta.label}</span>;
}

function ScheduleTableRow({ row, canMutate, onChanged }: { row: ScheduleRow; canMutate: boolean; onChanged: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const statusClass = row.statusTone === 'green'
    ? 'border-emerald-700 bg-emerald-600 text-white'
    : row.statusTone === 'amber'
      ? 'border-amber-500 bg-amber-400 text-slate-950'
      : 'border-sky-700 bg-sky-600 text-white';

  const runNow = () => {
    if (!canMutate) {
      setActionMessage('라이선스가 필요합니다.');
      return;
    }
    setBusy(true);
    setActionMessage('');
    void runAutomationTask(row.id)
      .then(() => {
        setActionMessage('실행 요청됨');
        setMenuOpen(false);
        onChanged();
      })
      .catch((error: unknown) => {
        setActionMessage(error instanceof Error ? error.message : '실행 요청에 실패했습니다.');
      })
      .finally(() => setBusy(false));
  };

  const toggleEnabled = () => {
    if (!canMutate) {
      setActionMessage('라이선스가 필요합니다.');
      return;
    }
    const nextEnabled = !row.enabled;
    setBusy(true);
    setActionMessage('');
    void setAutomationTaskEnabled(row.id, nextEnabled)
      .then(() => {
        setActionMessage(nextEnabled ? '다시 활성화됨' : '일시 중지됨');
        setMenuOpen(false);
        onChanged();
      })
      .catch((error: unknown) => {
        setActionMessage(error instanceof Error ? error.message : '상태 변경에 실패했습니다.');
      })
      .finally(() => setBusy(false));
  };

  const removeTask = async () => {
    if (!canMutate) {
      setActionMessage('라이선스가 필요합니다.');
      return;
    }
    const ok = await confirmDialog({
      title: '자동화 작업 삭제',
      message: `「${row.name}」 작업을 삭제할까요? 실행 기록은 유지될 수 있습니다.`,
      confirmLabel: '삭제',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setActionMessage('');
    try {
      await deleteAutomationTask(row.id);
      setActionMessage('삭제됨');
      setMenuOpen(false);
      onChanged();
    } catch (error: unknown) {
      setActionMessage(error instanceof Error ? error.message : '삭제에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="group grid gap-4 px-5 py-4 transition odd:bg-white/30 even:bg-panel/55 hover:bg-accent/5 md:grid-cols-[minmax(230px,1.45fr)_minmax(190px,1fr)_minmax(180px,0.9fr)_130px_32px] md:items-center md:gap-5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ring-4 ring-white ${row.statusTone === 'green' ? 'bg-emerald-600' : row.statusTone === 'amber' ? 'bg-amber-500' : 'bg-sky-600'}`} />
          <h3 className="truncate text-sm font-bold text-text">{row.name}</h3>
        </div>
        <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted">{row.description}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {row.triggers.map((kind) => <TriggerTag key={kind} kind={kind} />)}
      </div>
      <div className="flex items-center gap-2 text-xs font-medium text-text">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-panel-2/70 text-muted">
          <Clock size={14} weight="bold" />
        </span>
        <span className="leading-5">{row.nextRun}</span>
      </div>
      <div className={`flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-bold ${statusClass}`}>
        {row.status === '활성' ? <CheckCircle size={14} weight="fill" /> : row.status === '대기' ? <UserCircle size={14} /> : <WarningCircle size={14} />}
        <span>{row.status}</span>
      </div>
      <div
        className="relative"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
        }}
      >
        <button
          type="button"
          className="rounded-lg border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-white hover:text-text"
          aria-label={`${row.name} 처리 메뉴`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <DotsThree size={17} weight="bold" />
        </button>
        {menuOpen ? (
          <div role="menu" className="absolute right-0 top-9 z-20 w-40 rounded-xl border border-line bg-white p-1.5 shadow-[0_12px_32px_rgba(23,33,29,0.16)]">
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-text transition hover:bg-panel disabled:cursor-wait disabled:opacity-60"
              onClick={runNow}
            >
              <Play size={14} weight="fill" />
              {busy ? '처리 중…' : '즉시 실행'}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-text transition hover:bg-panel disabled:cursor-wait disabled:opacity-60"
              onClick={toggleEnabled}
            >
              {row.enabled ? <Pause size={14} weight="fill" /> : <Play size={14} />}
              {row.enabled ? '일시 중지' : '다시 활성화'}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-wait disabled:opacity-60"
              onClick={() => { void removeTask(); }}
            >
              <Trash size={14} />
              삭제
            </button>
          </div>
        ) : null}
        {actionMessage ? <span className="sr-only" role="status">{actionMessage}</span> : null}
      </div>
    </article>
  );
}

function ScheduleDraft({ canMutate, readOnlyNotice, onCancel, onSaved }: { canMutate: boolean; readOnlyNotice: string | null; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instruction, setInstruction] = useState('');
  const [scheduleMode, setScheduleMode] = useState<AutomationScheduleMode>('recurring');
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [dailyTime, setDailyTime] = useState('09:00');
  const [onceAt, setOnceAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleWeekday = (iso: number) => {
    setWeekdays((current) => (
      current.includes(iso) ? current.filter((day) => day !== iso) : [...current, iso].sort((a, b) => a - b)
    ));
  };

  const handleSave = () => {
    if (!canMutate) {
      setError(readOnlyNotice ?? '저장할 수 없습니다.');
      return;
    }
    setError('');
    const trimmedName = name.trim();
    const trimmedInstruction = instruction.trim();
    if (!trimmedName) {
      setError('일정 이름을 입력하세요.');
      return;
    }
    if (!trimmedInstruction) {
      setError('실행 지시를 입력하세요.');
      return;
    }
    setSaving(true);
    void (async () => {
      try {
        const triggers = buildAutomationTriggers({
          mode: scheduleMode,
          dailyTime: scheduleMode === 'recurring' ? dailyTime : undefined,
          weekdays: scheduleMode === 'recurring' ? weekdays : undefined,
          onceAt: scheduleMode === 'once' ? onceAt : undefined,
        });
        await saveAutomationTask({
          name: trimmedName,
          description: description.trim(),
          instruction: trimmedInstruction,
          triggers,
          enabled: true,
          misfire_policy: 'skip',
        });
        onSaved();
      } catch (saveError: unknown) {
        setError(saveError instanceof Error ? saveError.message : '자동화 작업을 저장하지 못했습니다.');
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">New schedule</p>
        <h2 className="mt-1 text-lg font-semibold text-text">새 일정</h2>
        <p className="mt-1 text-sm text-muted">실행 지시와 트리거를 설정하면 MY Agent가 예약대로 채팅 작업을 수행합니다.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="rounded-xl border border-line bg-ink/35 p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-text">
            <Clock size={16} className="text-accent" />
            타이밍
          </div>
          <div className="space-y-4">
            <label className="block text-xs font-medium text-text">
              일정 이름
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="예: 주간 웹 모니터링"
                className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </label>
            <label className="block text-xs font-medium text-text">
              설명
              <input
                type="text"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="작업 목적을 짧게 적어 두세요."
                className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </label>
            <label className="block text-xs font-medium text-text">
              실행 유형
              <select
                value={scheduleMode}
                onChange={(event) => setScheduleMode(event.target.value as AutomationScheduleMode)}
                className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent"
              >
                <option value="recurring">정기 실행</option>
                <option value="once">한 번 실행</option>
                <option value="manual">수동 실행</option>
              </select>
            </label>
            {scheduleMode === 'recurring' ? (
              <>
                <div>
                  <p className="text-xs font-medium text-text">반복 요일</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {WEEKDAY_OPTIONS.map((day) => {
                      const active = weekdays.includes(day.iso);
                      return (
                        <button
                          key={day.iso}
                          type="button"
                          aria-pressed={active}
                          onClick={() => toggleWeekday(day.iso)}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                            active
                              ? 'border-accent bg-accent text-white'
                              : 'border-line bg-panel text-muted hover:text-text'
                          }`}
                        >
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <label className="block text-xs font-medium text-text">
                  실행 시각
                  <input
                    type="time"
                    value={dailyTime}
                    onChange={(event) => setDailyTime(event.target.value)}
                    className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent"
                  />
                </label>
              </>
            ) : null}
            {scheduleMode === 'once' ? (
              <label className="block text-xs font-medium text-text">
                실행 시각
                <input
                  type="datetime-local"
                  value={onceAt}
                  onChange={(event) => setOnceAt(event.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
            ) : null}
            {scheduleMode === 'manual' ? (
              <p className="rounded-lg border border-line bg-panel px-3 py-2 text-xs leading-5 text-muted">
                수동 실행은 일정 목록에서 「즉시 실행」으로만 시작됩니다.
              </p>
            ) : null}
          </div>
        </section>

        <section className="rounded-xl border border-line bg-ink/35 p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-text">
            <Play size={16} className="text-accent" />
            실행 구성
          </div>
          <div className="space-y-4">
            <label className="block text-xs font-medium text-text">
              실행 지시
              <textarea
                rows={8}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="실행할 채팅 작업을 입력하세요."
                className="mt-1.5 w-full resize-none rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </label>
          </div>
        </section>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-4">
        {error ? (
          <p role="alert" className="flex items-center gap-2 text-xs text-red-700">
            <WarningCircle size={14} />
            {error}
          </p>
        ) : (
          <p className="text-xs text-muted">저장하면 즉시 활성화됩니다.</p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg border border-line px-3.5 py-2 text-xs font-medium text-muted transition hover:text-text disabled:opacity-60"
          >
            취소
          </button>
          <button
            type="button"
            disabled={saving || !canMutate}
            onClick={handleSave}
            className="rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-white transition hover:brightness-105 disabled:cursor-wait disabled:opacity-60"
          >
            {saving ? '저장 중…' : '저장 및 활성화'}
          </button>
        </div>
      </div>
    </div>
  );
}

const RUN_STATUS_META: Record<
  AutomationRun['status'],
  { label: string; className: string; icon: typeof CheckCircle }
> = {
  queued: { label: '대기', className: 'border-sky-700 bg-sky-600 text-white', icon: Clock },
  running: { label: '실행 중', className: 'border-amber-500 bg-amber-400 text-slate-950', icon: Lightning },
  succeeded: { label: '성공', className: 'border-emerald-700 bg-emerald-600 text-white', icon: CheckCircle },
  failed: { label: '실패', className: 'border-red-700 bg-red-600 text-white', icon: WarningCircle },
};

const RUN_SOURCE_LABEL: Record<AutomationRun['source'], string> = {
  scheduled: '예약',
  manual: '수동',
  action: '동작',
};

function RunsDashboard({ refreshKey }: { refreshKey: number }) {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [taskNames, setTaskNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    void Promise.all([listAutomationRuns(100), listAutomationTasks()])
      .then(([nextRuns, tasks]) => {
        if (cancelled) return;
        setRuns(nextRuns);
        setTaskNames(Object.fromEntries(tasks.map((task) => [task.id, task.name])));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : '실행 기록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (loading) {
    return <p className="py-16 text-center text-sm text-muted">실행 기록을 불러오는 중입니다.</p>;
  }

  if (loadError) {
    return <p role="alert" className="py-16 text-center text-sm text-red-700">{loadError}</p>;
  }

  if (runs.length === 0) {
    return (
      <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center py-16 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-ink text-muted">
          <Clock size={23} weight="duotone" />
        </div>
        <h2 className="text-base font-semibold text-text">아직 실행 기록이 없습니다</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted">
          예약 실행의 성공·실패 기록이 이곳에 표시되고, 결과와 파일은 작업 뉴스피드로 전달됩니다.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <section className="overflow-hidden rounded-2xl border border-line bg-white/80 shadow-[0_8px_28px_rgba(23,33,29,0.08)]">
        <div className="border-b border-line bg-white px-5 py-4">
          <h2 className="text-[15px] font-bold text-text">실행 기록</h2>
          <p className="mt-1 text-xs leading-5 text-muted">최근 자동화 실행 결과입니다. 상세 결과는 작업 뉴스피드에서 확인하세요.</p>
        </div>
        <div className="hidden grid-cols-[minmax(180px,1.2fr)_100px_120px_minmax(160px,1fr)_minmax(180px,1fr)] gap-4 border-b border-line bg-panel-2/55 px-5 py-3 text-[11px] font-bold tracking-[0.04em] text-text md:grid">
          <span>작업</span>
          <span>출처</span>
          <span>상태</span>
          <span>시작</span>
          <span>결과</span>
        </div>
        <div className="divide-y divide-line/80">
          {runs.map((run) => {
            const meta = RUN_STATUS_META[run.status];
            const StatusIcon = meta.icon;
            const startedAt = run.started_at ?? run.created_at;
            const startedLabel = startedAt
              ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(startedAt))
              : '-';
            const resultText = run.status === 'failed'
              ? run.error || '오류'
              : run.result_text || (run.status === 'running' || run.status === 'queued' ? '진행 중' : '-');
            return (
              <article
                key={run.id}
                className="grid gap-3 px-5 py-4 odd:bg-white/30 even:bg-panel/55 md:grid-cols-[minmax(180px,1.2fr)_100px_120px_minmax(160px,1fr)_minmax(180px,1fr)] md:items-center md:gap-4"
              >
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-bold text-text">{taskNames[run.task_id] ?? run.task_id}</h3>
                  <p className="mt-1 text-[11px] text-muted">{run.id}</p>
                </div>
                <span className="text-xs font-medium text-text">{RUN_SOURCE_LABEL[run.source]}</span>
                <div className={`flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-bold ${meta.className}`}>
                  <StatusIcon size={14} weight="fill" />
                  <span>{meta.label}</span>
                </div>
                <span className="text-xs text-text">{startedLabel}</span>
                <p className="line-clamp-2 text-xs leading-5 text-muted">{resultText}</p>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
