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
import { useState } from 'react';

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
          <p className="mt-1 text-sm text-muted">지정한 시각에 독립된 채팅 작업을 실행합니다.</p>
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
  name: string;
  description: string;
  triggers: TriggerKind[];
  nextRun: string;
  status: '활성' | '대기' | '확인 필요';
  statusTone: 'green' | 'amber' | 'blue';
};

const SCHEDULE_ROWS: ScheduleRow[] = [
  {
    name: '주간 시장 동향 리포트',
    description: '지정한 주제의 최신 뉴스를 검색하고 핵심 변화만 요약합니다.',
    triggers: ['Time', 'Sequence'],
    nextRun: '9월 1일 · 09:00',
    status: '활성',
    statusTone: 'green',
  },
  {
    name: '배포 후 회귀 점검',
    description: '배포 완료 뒤 핵심 경로를 점검하고 실패 항목을 알려줍니다.',
    triggers: ['On action', 'Condition'],
    nextRun: '배포 이벤트 대기',
    status: '대기',
    statusTone: 'blue',
  },
  {
    name: '미완료 작업 요약',
    description: '당일 미완료 작업을 모아 다음 업무 시작 전에 보여줍니다.',
    triggers: ['Time'],
    nextRun: '매일 · 18:00',
    status: '활성',
    statusTone: 'green',
  },
  {
    name: '긴급 조사 실행',
    description: '필요할 때 직접 실행해 단일 주제의 조사 결과를 만듭니다.',
    triggers: ['Manual'],
    nextRun: '수동 실행',
    status: '확인 필요',
    statusTone: 'amber',
  },
];

const TRIGGER_META: Record<TriggerKind, { label: string; className: string }> = {
  Time: { label: 'Time', className: 'border-sky-400/25 bg-sky-400/10 text-sky-300' },
  Sequence: { label: 'Sequence', className: 'border-violet-400/25 bg-violet-400/10 text-violet-300' },
  'On action': { label: 'On action', className: 'border-orange-400/25 bg-orange-400/10 text-orange-300' },
  Condition: { label: 'Condition', className: 'border-fuchsia-400/25 bg-fuchsia-400/10 text-fuchsia-300' },
  Manual: { label: 'Manual', className: 'border-slate-400/25 bg-slate-400/10 text-slate-300' },
};

function ScheduleDashboard({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="활성 작업" value="3" detail="예약 실행 중" tone="accent" />
        <SummaryCard label="다음 실행" value="09:00" detail="주간 시장 동향 리포트" tone="blue" />
        <SummaryCard label="확인 필요" value="1" detail="긴급 조사 실행" tone="amber" />
      </div>

      <section className="overflow-hidden rounded-xl border border-line bg-ink/25">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-text">자동화 작업</h2>
            <p className="mt-0.5 text-[11px] text-muted">작업 설명과 실행 조건을 한 행에서 확인합니다.</p>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted">
            <span className="rounded-full border border-line bg-panel px-2 py-1">화면 예시</span>
            <button
              type="button"
              onClick={onCreate}
              className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1.5 font-semibold text-accent transition hover:bg-accent/20"
            >
              <Plus size={12} weight="bold" />
              작업 추가
            </button>
          </div>
        </div>

        <div className="hidden grid-cols-[minmax(210px,1.4fr)_minmax(180px,1fr)_minmax(180px,1fr)_120px_32px] gap-4 border-b border-line bg-panel/40 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted md:grid">
          <span>작업</span>
          <span>트리거</span>
          <span>다음 실행</span>
          <span>상태</span>
          <span />
        </div>

        <div className="divide-y divide-line">
          {SCHEDULE_ROWS.map((row) => (
            <ScheduleTableRow key={row.name} row={row} />
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-panel/50 px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <Lightning size={15} weight="duotone" className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-text">트리거 태그 안내</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <TriggerTag kind="Time" />
              <TriggerTag kind="Sequence" />
              <TriggerTag kind="On action" />
              <TriggerTag kind="Condition" />
              <TriggerTag kind="Manual" />
            </div>
            <p className="mt-2 text-[11px] leading-5 text-muted">
              시간 기반 실행 외에도 이전 작업 완료, 다른 작업의 동작, 조건 충족, 사용자 직접 실행을 같은 속성으로 확장할 수 있습니다.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function SummaryCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'accent' | 'blue' | 'amber' }) {
  const toneClass = tone === 'accent' ? 'text-accent' : tone === 'blue' ? 'text-sky-300' : 'text-amber-300';
  return (
    <div className="rounded-xl border border-line bg-ink/25 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`text-xl font-semibold ${toneClass}`}>{value}</span>
        <span className="truncate text-[11px] text-muted">{detail}</span>
      </div>
    </div>
  );
}

function TriggerTag({ kind }: { kind: TriggerKind }) {
  const meta = TRIGGER_META[kind];
  return <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-medium ${meta.className}`}>{meta.label}</span>;
}

function ScheduleTableRow({ row }: { row: ScheduleRow }) {
  const statusClass = row.statusTone === 'green'
    ? 'text-emerald-300'
    : row.statusTone === 'amber'
      ? 'text-amber-300'
      : 'text-sky-300';
  return (
    <article className="group grid gap-3 px-4 py-3.5 transition hover:bg-hover/30 md:grid-cols-[minmax(210px,1.4fr)_minmax(180px,1fr)_minmax(180px,1fr)_120px_32px] md:items-center md:gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${row.statusTone === 'green' ? 'bg-emerald-400' : row.statusTone === 'amber' ? 'bg-amber-400' : 'bg-sky-400'}`} />
          <h3 className="truncate text-xs font-semibold text-text">{row.name}</h3>
        </div>
        <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted">{row.description}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {row.triggers.map((kind) => <TriggerTag key={kind} kind={kind} />)}
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <Clock size={13} className="shrink-0" />
        <span>{row.nextRun}</span>
      </div>
      <div className={`flex items-center gap-1.5 text-[11px] font-medium ${statusClass}`}>
        {row.status === '활성' ? <CheckCircle size={14} weight="fill" /> : row.status === '대기' ? <UserCircle size={14} /> : <WarningCircle size={14} />}
        <span>{row.status}</span>
      </div>
      <button type="button" className="hidden rounded-md p-1 text-muted transition hover:bg-panel hover:text-text md:block" aria-label={`${row.name} 더보기`}>
        <DotsThree size={17} weight="bold" />
      </button>
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
        예약 실행 결과와 확인이 필요한 알림이 이곳에 표시됩니다.
      </p>
    </div>
  );
}
