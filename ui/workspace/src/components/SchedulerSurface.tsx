import {
  CheckCircle,
  Clock,
  DotsThree,
  Lightning,
  Play,
  Plus,
  UserCircle,
  WarningCircle,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import {
  listAutomationTasks,
  runAutomationTask,
  type AutomationTask,
  type AutomationTaskTrigger,
} from '../api/myAgentClient';

type SchedulerTab = 'schedules' | 'runs';

export function SchedulerSurface() {
  const [activeTab, setActiveTab] = useState<SchedulerTab>('schedules');
  const [creating, setCreating] = useState(false);

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="자동화">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-7 py-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Feature</p>
          <h1 className="mt-1 text-xl font-semibold text-text">자동화</h1>
          <p className="mt-1 text-sm text-muted">시간이나 동작 조건에 맞춰 개인화된 채팅 작업을 실행합니다.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setActiveTab('schedules');
            setCreating(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-white transition hover:brightness-105"
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
            <ScheduleDraft onCancel={() => setCreating(false)} />
          ) : (
            <ScheduleDashboard onCreate={() => setCreating(true)} />
          )
        ) : (
          <EmptyRuns />
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
    status: task.enabled ? '활성' : '대기',
    statusTone: task.enabled ? 'green' : 'blue',
  };
}

const TRIGGER_META: Record<TriggerKind, { label: string; className: string }> = {
  Time: { label: 'Time', className: 'border-cyan-600 bg-cyan-500 text-slate-950' },
  Sequence: { label: 'Sequence', className: 'border-violet-700 bg-violet-600 text-white' },
  'On action': { label: 'On action', className: 'border-orange-600 bg-orange-500 text-slate-950' },
  Condition: { label: 'Condition', className: 'border-fuchsia-700 bg-fuchsia-600 text-white' },
  Manual: { label: 'Manual', className: 'border-slate-700 bg-slate-600 text-white' },
};

function ScheduleDashboard({ onCreate }: { onCreate: () => void }) {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void listAutomationTasks()
      .then((tasks) => {
        if (!cancelled) setRows(tasks.map(taskToRow));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : '자동화 작업을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard label="예약 작업" value={String(rows.length)} detail="등록된 실제 작업" tone="accent" />
        <SummaryCard label="다음 실행" value={rows[0]?.nextRun ?? '-'} detail={rows[0]?.name ?? '예약 작업 없음'} tone="blue" />
        <SummaryCard label="실행 오류" value="0" detail="최근 7일" tone="green" />
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
              onClick={onCreate}
              className="inline-flex items-center gap-1.5 rounded-lg border border-accent bg-accent px-3 py-2 font-bold text-white shadow-sm transition hover:bg-accent-dim"
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
            <ScheduleTableRow key={row.id} row={row} />
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
              <TriggerTag kind="Sequence" />
              <TriggerTag kind="On action" />
              <TriggerTag kind="Condition" />
              <TriggerTag kind="Manual" />
            </div>
            <p className="mt-2.5 text-xs leading-5 text-muted">
              시간 기반 실행 외에도 이전 작업 완료, 다른 작업의 동작, 조건 충족, 사용자 직접 실행을 같은 속성으로 확장할 수 있습니다.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function SummaryCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'accent' | 'blue' | 'green' }) {
  const toneClass = tone === 'accent' ? 'text-accent-dim' : tone === 'blue' ? 'text-sky-700' : 'text-emerald-700';
  const edgeClass = tone === 'accent' ? 'border-l-accent' : tone === 'blue' ? 'border-l-sky-600' : 'border-l-emerald-600';
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

function ScheduleTableRow({ row }: { row: ScheduleRow }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState('');
  const statusClass = row.statusTone === 'green'
    ? 'border-emerald-700 bg-emerald-600 text-white'
    : row.statusTone === 'amber'
      ? 'border-amber-500 bg-amber-400 text-slate-950'
      : 'border-sky-700 bg-sky-600 text-white';
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
        className="relative hidden md:block"
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
          <div role="menu" className="absolute right-0 top-9 z-20 w-36 rounded-xl border border-line bg-white p-1.5 shadow-[0_12px_32px_rgba(23,33,29,0.16)]">
            <button
              type="button"
              role="menuitem"
              disabled={running}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-text transition hover:bg-panel disabled:cursor-wait disabled:opacity-60"
              onClick={() => {
                setRunning(true);
                setRunMessage('');
                void runAutomationTask(row.id)
                  .then(() => {
                    setRunMessage('실행 요청됨');
                    setMenuOpen(false);
                  })
                  .catch((error: unknown) => {
                    setRunMessage(error instanceof Error ? error.message : '실행 요청에 실패했습니다.');
                  })
                  .finally(() => setRunning(false));
              }}
            >
              <Play size={14} weight="fill" />
              {running ? '실행 요청 중…' : '즉시 실행'}
            </button>
          </div>
        ) : null}
        {runMessage ? <span className="sr-only" role="status">{runMessage}</span> : null}
      </div>
    </article>
  );
}

function ScheduleDraft({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">New schedule</p>
        <h2 className="mt-1 text-lg font-semibold text-text">새 일정</h2>
        <p className="mt-1 text-sm text-muted">이번 단계에서는 화면 구조만 구성합니다. 저장은 백엔드 연결 단계에서 활성화됩니다.</p>
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
                placeholder="예: 주간 웹 모니터링"
                className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </label>
            <label className="block text-xs font-medium text-text">
              실행 유형
              <select className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent">
                <option>정기 실행</option>
                <option>한 번 실행</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-text">
                반복 규칙
                <select className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent">
                  <option>매주 첫 영업일</option>
                  <option>매주 특정 요일</option>
                  <option>매월 첫 영업일</option>
                </select>
              </label>
              <label className="block text-xs font-medium text-text">
                실행 시각
                <input
                  type="time"
                  defaultValue="09:00"
                  className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-line bg-ink/35 p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-text">
            <Play size={16} className="text-accent" />
            실행 구성
          </div>
          <div className="space-y-4">
            <label className="block text-xs font-medium text-text">
              채팅 환경
              <select className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent">
                <option>완전 독립 실행</option>
                <option>이전 성공 결과만 참고</option>
              </select>
            </label>
            <label className="block text-xs font-medium text-text">
              실행 지시
              <textarea
                rows={5}
                placeholder="실행할 채팅 작업을 입력하세요."
                className="mt-1.5 w-full resize-none rounded-lg border border-line bg-panel px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </label>
          </div>
        </section>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-4">
        <div className="flex items-center gap-2 text-xs text-muted">
          <WarningCircle size={14} />
          백엔드 연결 전에는 저장되지 않습니다.
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-line px-3.5 py-2 text-xs font-medium text-muted transition hover:text-text"
          >
            취소
          </button>
          <button
            type="button"
            disabled
            className="rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-white opacity-45"
          >
            저장 및 활성화
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyRuns() {
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
