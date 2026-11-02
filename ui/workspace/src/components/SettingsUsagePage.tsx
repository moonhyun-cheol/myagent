import { CaretRight, ChartLine } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchLlmUsageSummary, setLlmUsageTracking,
  type LlmUsageCall, type LlmUsageRangeQuery, type LlmUsageSession, type LlmUsageSummary, type LlmUsageTotals, type LlmUsageTracking, type LlmUsageTurn,
} from '../api/myAgentClient';

type Metric = 'tokens' | 'cost';
type GroupBy = 'sessions' | 'models' | 'providers' | 'purposes';
type Range = 7 | 30 | 90 | 'all' | 'custom';

const GROUP_LABEL: Record<GroupBy, { short: string; column: string }> = {
  sessions: { short: '대화방별', column: '대화방' },
  models: { short: '모델별', column: '모델' },
  providers: { short: '공급자별', column: '공급자' },
  purposes: { short: '용도별', column: '용도' },
};

const PURPOSE_LABEL: Record<string, string> = {
  chat: '대화·에이전트',
  approval: '승인 판단',
  image: '이미지 생성',
  video: '영상 생성',
  embedding: '임베딩',
};

/** Fixed colors so a purpose keeps its color across the question / task charts. */
const PURPOSE_COLOR: Record<string, string> = {
  chat: '#6366f1',
  approval: '#a855f7',
  image: '#22c55e',
  video: '#06b6d4',
  embedding: '#f59e0b',
};
const purposeColor = (p: string) => PURPOSE_COLOR[p] ?? '#94a3b8';
const purposeLabel = (p: string) => PURPOSE_LABEL[p] ?? p;

const pad2 = (n: number) => String(n).padStart(2, '0');

function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatSince(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Share of input tokens served from the prompt cache (input already includes cache reads). */
function formatCacheRatio(ratio: number): string {
  if (!(ratio > 0)) return '0%';
  const pct = Math.min(ratio, 1) * 100;
  return pct < 1 ? '<1%' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

function TrackingSwitch({ on, disabled, onChange }: { on: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="사용량·비용 집계"
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-accent' : 'bg-line'}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

function trackingMessage(t: LlmUsageTracking | undefined): { title: string; body: string } {
  if (!t) return { title: '불러오는 중…', body: '' };
  const paused = t.periods.length > 1 || (!t.enabled && t.periods.length > 0);
  if (t.enabled) {
    return {
      title: `집계 중 · ${formatSince(t.first_started_at ?? t.periods[t.periods.length - 1].from)}~`,
      body: paused
        ? '일시 중지했던 구간의 사용량은 제외됩니다.'
        : '켜 둔 동안 발생한 토큰과 비용을 집계하고 있습니다.',
    };
  }
  if (paused) {
    return { title: '일시 중지됨', body: '지금까지 집계된 내역은 그대로 조회할 수 있으며, 다시 켜면 이어서 집계합니다.' };
  }
  return {
    title: '꺼짐',
    body: '스위치를 켠 시점부터 토큰과 비용을 집계합니다. 이전 기록은 포함하지 않습니다.',
  };
}

type ChartMode = 'daily' | 'cumulative';

const PAGE = 20;

/** Cache effect in words: discount = 절감, cache-write premium larger than the discount = 추가. */
function savingsText(v: number): { text: string; cls: string } {
  if (v < 0) return { text: `+${formatUsd(-v)} 추가`, cls: 'text-amber-500' };
  if (v > 0) return { text: `${formatUsd(v)} 절감`, cls: 'text-emerald-500' };
  return { text: '-', cls: 'text-muted' };
}

function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}초`;
  if (s < 60) return `${Math.round(s)}초`;
  return `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`;
}

const turnKeyOf = (t: LlmUsageTurn) => `${t.session_id ?? ''}\u0000${t.turn_id}`;

function sessionName(id: string | undefined, title: string | undefined): string {
  if (title) return title;
  if (!id) return '대화방 밖 호출';
  return `(삭제된 대화방 · ${id.slice(0, 6)})`;
}

type Sort = 'recent' | 'cost' | 'tokens';
const SORT_OPTIONS: Array<{ value: Sort; label: string }> = [
  { value: 'recent', label: '최신순' },
  { value: 'cost', label: '비용순' },
  { value: 'tokens', label: '토큰순' },
];

function sortItems<T extends LlmUsageTotals>(items: T[], sort: Sort, time: (x: T) => string): T[] {
  const list = [...items];
  if (sort === 'cost') return list.sort((a, b) => b.cost_usd - a.cost_usd || b.total_tokens - a.total_tokens);
  if (sort === 'tokens') return list.sort((a, b) => b.total_tokens - a.total_tokens);
  return list.sort((a, b) => Date.parse(time(b)) - Date.parse(time(a)));
}

function CostCell({ t }: { t: LlmUsageTotals }) {
  return (
    <>
      {formatUsd(t.cost_usd)}
      {t.billed_cost_usd > 0 ? null : t.estimated_cost_usd > 0 ? <span className="ml-1 text-muted">추정</span> : null}
      {t.unpriced_requests > 0 ? <span className="ml-1 text-amber-500" title={`청구액도 단가 정보도 없는 작업 ${t.unpriced_requests}건은 비용에서 빠졌습니다`}>*</span> : null}
    </>
  );
}

const cacheRatioText = (t: { input_tokens: number; cached_tokens: number }) =>
  (t.input_tokens > 0 ? formatCacheRatio(t.cached_tokens / t.input_tokens) : '-');

const TH = 'sticky top-0 bg-panel py-2 font-medium';
const TD = 'py-2 pr-3 align-top';

function MoreButton({ left, onClick }: { left: number; onClick: () => void }) {
  if (left <= 0) return null;
  return (
    <button type="button" onClick={onClick} className="mt-3 rounded-lg border border-line px-3 py-1 text-xs text-muted hover:text-text">
      더 보기 ({left.toLocaleString()}개 남음)
    </button>
  );
}

/** 1단계: one row per conversation. */
function SessionsTable({ items, onOpen }: { items: LlmUsageSession[]; onOpen: (s: LlmUsageSession) => void }) {
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full text-left text-xs tabular-nums">
          <thead className="text-muted">
            <tr className="border-b border-line">
              <th className={`${TH} pr-3`}>최근 활동</th>
              <th className={`${TH} pr-3`}>대화방</th>
              <th className={`${TH} pr-3 text-right`}>질문</th>
              <th className={`${TH} pr-3 text-right`}>작업</th>
              <th className={`${TH} pr-3 text-right`}>토큰</th>
              <th className={`${TH} pr-3 text-right`} title="입력 토큰 중 캐시에서 읽은 비율">캐시 비율</th>
              <th className={`${TH} pr-3 text-right`}>비용</th>
              <th className={`${TH} text-right`}>캐시 절감</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, shown).map((s) => {
              const sv = savingsText(s.cache_savings_usd);
              return (
                <tr key={s.session_id} className="cursor-pointer border-b border-line/60 hover:bg-line/20" onClick={() => onOpen(s)}>
                  <td className={`${TD} whitespace-nowrap text-muted`}>{formatStamp(s.last_at)}</td>
                  <td className={`${TD} max-w-80`}>
                    <div className="flex items-center gap-1">
                      <span className="truncate text-text" title={s.session_title}>{sessionName(s.session_id, s.session_title)}</span>
                      <CaretRight size={11} className="shrink-0 text-muted" />
                    </div>
                  </td>
                  <td className={`${TD} text-right`}>{s.turn_count ? s.turn_count.toLocaleString() : '-'}</td>
                  <td className={`${TD} text-right`}>
                    {s.requests.toLocaleString()}
                    {s.failed_requests ? <span className="ml-1 text-muted">({s.failed_requests} 실패)</span> : null}
                  </td>
                  <td className={`${TD} text-right`}>{formatTokens(s.total_tokens)}</td>
                  <td className={`${TD} text-right`}>{cacheRatioText(s)}</td>
                  <td className={`${TD} whitespace-nowrap text-right`}><CostCell t={s} /></td>
                  <td className={`whitespace-nowrap py-2 text-right align-top ${sv.cls}`}>{sv.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <MoreButton left={items.length - shown} onClick={() => setShown((n) => n + PAGE * 5)} />
    </>
  );
}

/** 2단계 (or the flat 「전체 질문」 tab): one row per question. */
function QuestionsTable({ items, showSession, onOpen }: {
  items: LlmUsageTurn[];
  showSession: boolean;
  onOpen: (t: LlmUsageTurn) => void;
}) {
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full text-left text-xs tabular-nums">
          <thead className="text-muted">
            <tr className="border-b border-line">
              <th className={`${TH} pr-3`}>시각</th>
              <th className={`${TH} pr-3`}>질문</th>
              <th className={`${TH} pr-3 text-right`}>작업</th>
              <th className={`${TH} pr-3 text-right`}>토큰</th>
              <th className={`${TH} pr-3 text-right`} title="입력 토큰 중 캐시에서 읽은 비율">캐시 비율</th>
              <th className={`${TH} pr-3 text-right`}>비용</th>
              <th className={`${TH} text-right`}>캐시 절감</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, shown).map((t) => {
              const k = turnKeyOf(t);
              const sv = savingsText(t.cache_savings_usd);
              const no = t.question_no;
              return (
                <tr key={k} className="cursor-pointer border-b border-line/60 hover:bg-line/20" onClick={() => onOpen(t)}>
                  <td className={`${TD} whitespace-nowrap text-muted`}>{formatStamp(t.started_at)}</td>
                  <td className={`${TD} max-w-80`}>
                    <div className="flex items-center gap-1">
                      {no ? <span className="shrink-0 rounded bg-line/50 px-1 text-[10px] text-muted">#{no}</span> : null}
                      <span className="truncate text-text" title={t.question}>{t.question || <span className="text-muted">(질문 내용을 찾을 수 없음)</span>}</span>
                      {t.continued_runs ? (
                        <span
                          className="shrink-0 rounded bg-accent/15 px-1 text-[10px] text-accent"
                          title={`이 질문의 작업을 이어서 진행한 질문 ${t.continued_runs}개의 사용량이 함께 들어 있습니다.`}
                        >
                          이어서 {t.continued_runs}회
                        </span>
                      ) : null}
                      <CaretRight size={11} className="shrink-0 text-muted" />
                    </div>
                    {showSession ? (
                      <div className="truncate text-[11px] text-muted" title={t.session_title}>대화방: {sessionName(t.session_id, t.session_title)}</div>
                    ) : null}
                  </td>
                  <td className={`${TD} text-right`}>
                    {t.requests.toLocaleString()}
                    {t.failed_requests ? <span className="ml-1 text-muted">({t.failed_requests} 실패)</span> : null}
                  </td>
                  <td className={`${TD} text-right`}>{formatTokens(t.total_tokens)}</td>
                  <td className={`${TD} text-right`}>{cacheRatioText(t)}</td>
                  <td className={`${TD} whitespace-nowrap text-right`}><CostCell t={t} /></td>
                  <td className={`whitespace-nowrap py-2 text-right align-top ${sv.cls}`}>{sv.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <MoreButton left={items.length - shown} onClick={() => setShown((n) => n + PAGE * 5)} />
    </>
  );
}

/** 3단계: every AI call made for one question, in order. */
function CallsTable({ calls }: { calls: LlmUsageCall[] }) {
  return (
    <div className="max-h-[32rem] overflow-auto">
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="text-muted">
          <tr className="border-b border-line">
            <th className={`${TH} pr-3 text-right`}>#</th>
            <th className={`${TH} pr-3`}>시각</th>
            <th className={`${TH} pr-3`}>작업 종류</th>
            <th className={`${TH} pr-3`}>모델</th>
            <th className={`${TH} pr-3 text-right`}>입력</th>
            <th className={`${TH} pr-3 text-right`}>캐시 읽기</th>
            <th className={`${TH} pr-3 text-right`}>출력</th>
            <th className={`${TH} pr-3 text-right`}>비용</th>
            <th className={`${TH} pr-3 text-right`}>소요</th>
            <th className={`${TH} text-right`}>캐시 절감</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c, i) => {
            const sv = savingsText(c.savings_usd);
            return (
              <tr key={`${c.started_at}-${i}`} className="border-b border-line/60 last:border-0">
                <td className={`${TD} text-right text-muted`}>{i + 1}</td>
                <td className={`${TD} whitespace-nowrap text-muted`}>{formatStamp(c.started_at)}</td>
                <td className={`${TD} whitespace-nowrap`}>
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: purposeColor(c.purpose) }} />
                  {purposeLabel(c.purpose)}
                  {c.failed ? <span className="ml-1 text-red-500">실패</span> : null}
                </td>
                <td className={`${TD} max-w-56 truncate`} title={c.model}>{c.model}</td>
                <td className={`${TD} text-right`}>{formatTokens(c.input_tokens)}</td>
                <td className={`${TD} text-right`} title={c.cache_write_tokens ? `캐시 저장 ${c.cache_write_tokens.toLocaleString()}` : undefined}>
                  {c.cached_tokens ? formatTokens(c.cached_tokens) : '-'}
                </td>
                <td className={`${TD} text-right`}>{formatTokens(c.output_tokens)}</td>
                <td className={`${TD} whitespace-nowrap text-right`}>
                  {formatUsd(c.cost_usd)}
                  {!c.billed && c.cost_usd > 0 ? <span className="ml-1 text-muted">추정</span> : null}
                  {c.unpriced ? <span className="ml-1 text-amber-500" title="청구액도 단가 정보도 없어 비용에서 빠졌습니다">*</span> : null}
                </td>
                <td className={`${TD} whitespace-nowrap text-right text-muted`}>{formatDuration(c.duration_ms)}</td>
                <td className={`whitespace-nowrap py-2 text-right align-top ${sv.cls}`}>{sv.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface BarSegment { key: string; label: string; color: string; value: number }
interface Bar { id: string; label: string; title: string; detail?: string; segments: BarSegment[] }

/** Stacked bars in order (questions of a conversation, or tasks of a question). */
function StackedBars({ bars, format, onPick }: { bars: Bar[]; format: (n: number) => string; onPick?: (i: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 260;
  const L = 64;
  const R = 12;
  const T = 12;
  const B = 28;
  const n = bars.length;
  const sums = bars.map((b) => b.segments.reduce((s, x) => s + x.value, 0));
  const yMax = niceCeil(Math.max(0, ...sums));
  const slot = (W - L - R) / Math.max(1, n);
  const bw = Math.max(2, Math.min(48, slot * 0.7));
  const x = (i: number) => L + slot * i + slot / 2;
  const y = (v: number) => T + (H - T - B) * (1 - v / yMax);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const labelEvery = Math.max(1, Math.ceil(n / 14));
  const hb = hover !== null ? bars[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="막대 차트" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-line" strokeWidth={1} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="currentColor" className="text-muted">{format(t)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          let base = 0;
          return (
            <g key={b.id} opacity={hover === null || hover === i ? 1 : 0.55}>
              {b.segments.map((s) => {
                const lo = base;
                base += s.value;
                return s.value > 0 ? (
                  <rect key={s.key} x={x(i) - bw / 2} y={y(base)} width={bw} height={Math.max(0, y(lo) - y(base))} fill={s.color} fillOpacity={0.8} />
                ) : null;
              })}
              {i % labelEvery === 0 || i === n - 1 ? (
                <text x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="currentColor" className="text-muted">{b.label}</text>
              ) : null}
            </g>
          );
        })}
        {bars.map((b, i) => (
          <rect
            key={`hit-${b.id}`}
            x={L + slot * i}
            y={T}
            width={slot}
            height={H - T - B}
            fill="transparent"
            className={onPick ? 'cursor-pointer' : undefined}
            onMouseEnter={() => setHover(i)}
            onClick={onPick ? () => onPick(i) : undefined}
          />
        ))}
      </svg>
      {hb && hover !== null ? (
        <div
          className="pointer-events-none absolute top-2 z-10 w-64 rounded-lg border border-line bg-panel px-3 py-2 text-xs shadow-lg"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: x(hover) > W / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}
        >
          <p className="mb-0.5 line-clamp-2 font-semibold text-text">{hb.title}</p>
          {hb.detail ? <p className="mb-1 text-[11px] text-muted">{hb.detail}</p> : null}
          {hb.segments.filter((s) => s.value > 0).map((s) => (
            <p key={s.key} className="flex items-center gap-2 text-muted">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="text-text">{format(s.value)}</span>
            </p>
          ))}
          <p className="mt-1 border-t border-line pt-1 text-muted">합계 <span className="float-right text-text">{format(sums[hover])}</span></p>
          {onPick ? <p className="mt-1 text-[10px] text-muted">누르면 작업 내역을 봅니다</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Legend({ items, format }: { items: Array<{ key: string; label: string; color: string; total?: number; onClick?: () => void }>; format: (n: number) => string }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((s) => {
        const body = (
          <>
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="max-w-56 truncate">{s.label}</span>
            {s.total !== undefined ? <span className="text-text">{format(s.total)}</span> : null}
          </>
        );
        return s.onClick ? (
          <button key={s.key} type="button" onClick={s.onClick} className="flex items-center gap-1.5 hover:text-accent" title="이 대화방 보기">{body}</button>
        ) : (
          <span key={s.key} className="flex items-center gap-1.5">{body}</span>
        );
      })}
    </div>
  );
}

function Breadcrumb({ items }: { items: Array<{ label: string; onClick?: () => void }> }) {
  return (
    <nav aria-label="사용량 단계" className="mb-3 flex min-w-0 flex-wrap items-center gap-1 text-xs">
      {items.map((it, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 ? <CaretRight size={11} className="shrink-0 text-muted" /> : null}
          {it.onClick ? (
            <button type="button" onClick={it.onClick} className="max-w-72 truncate rounded px-1 text-accent hover:underline">{it.label}</button>
          ) : (
            <span className="max-w-96 truncate px-1 font-medium text-text" title={it.label}>{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

const RANGE_OPTIONS: Array<{ value: Range; label: string }> = [
  { value: 7, label: '7일' },
  { value: 30, label: '30일' },
  { value: 90, label: '90일' },
  { value: 'all', label: '전체' },
  { value: 'custom', label: '기간 지정' },
];
const MAX_SERIES = 7;
const OTHER_KEY = '기타';
const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#94a3b8'];

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
  total: number;
}

function Segmented<T extends string | number>({
  value, options, onChange, label,
}: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-ink p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${o.value === value ? 'bg-panel text-text shadow-sm' : 'text-muted hover:text-text'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function UsageChart({
  dates, series, mode, format,
}: { dates: string[]; series: Series[]; mode: ChartMode; format: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 260;
  const L = 64;
  const R = 12;
  const T = 12;
  const B = 28;
  const n = dates.length;
  // 누적 mode stacks each item's running total, so the top edge is the overall running total.
  const shown = useMemo<Series[]>(() => (mode === 'cumulative'
    ? series.map((s) => ({ ...s, values: s.values.reduce<number[]>((acc, v, i) => { acc.push((acc[i - 1] ?? 0) + v); return acc; }, []) }))
    : series), [mode, series]);
  const daySum = dates.map((_, i) => shown.reduce((s, x) => s + x.values[i], 0));
  const maxRaw = Math.max(0, ...daySum);
  const yMax = niceCeil(maxRaw);
  const x = (i: number) => L + (n <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / yMax);
  const pts = (vals: number[]) => vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const labelEvery = Math.max(1, Math.ceil(n / 7));
  const BAR = 56;

  const stackedLayers = useMemo(() => {
    const base = new Array<number>(n).fill(0);
    return shown.map((s) => {
      const lower = [...base];
      const upper = base.map((b, i) => b + s.values[i]);
      for (let i = 0; i < n; i += 1) base[i] = upper[i];
      return { s, lower, upper };
    });
  }, [shown, n]);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={mode === 'cumulative' ? '누적 사용량 차트' : '일별 사용량 차트'} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-line" strokeWidth={1} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="currentColor" className="text-muted">{format(t)}</text>
          </g>
        ))}
        {dates.map((d, i) => (i % labelEvery === 0 || i === n - 1 ? (
          <text key={d} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="currentColor" className="text-muted">{d.slice(5)}</text>
        ) : null))}

        {n === 1 && stackedLayers.map(({ s, lower, upper }) => (
          <rect key={s.key} x={x(0) - BAR / 2} y={y(upper[0])} width={BAR} height={Math.max(0, y(lower[0]) - y(upper[0]))} fill={s.color} fillOpacity={0.75} />
        ))}
        {n > 1 && stackedLayers.map(({ s, lower, upper }) => (
          <polygon
            key={s.key}
            points={`${pts(upper)} ${[...lower].reverse().map((v, ri) => `${x(n - 1 - ri).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}`}
            fill={s.color}
            fillOpacity={0.55}
            stroke={s.color}
            strokeWidth={1}
          />
        ))}

        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="currentColor" className="text-muted" strokeDasharray="3 3" />}
        {dates.map((d, i) => {
          const half = n <= 1 ? (W - L - R) / 2 : (W - L - R) / (n - 1) / 2;
          return (
            <rect key={d} x={x(i) - half} y={T} width={half * 2} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} />
          );
        })}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-lg border border-line bg-panel px-3 py-2 text-xs shadow-lg"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: x(hover) > W / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}
        >
          <p className="mb-1 font-semibold text-text">{dates[hover]}{mode === 'cumulative' ? '까지 누적' : ''}</p>
          {shown.filter((s) => s.values[hover] > 0).map((s) => (
            <p key={s.key} className="flex items-center gap-2 text-muted">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="text-text">{format(s.values[hover])}</span>
            </p>
          ))}
          <p className="mt-1 border-t border-line pt-1 text-muted">합계 <span className="float-right text-text">{format(daySum[hover])}</span></p>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, hint, onHintClick }: { label: string; value: string; hint?: string; onHintClick?: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
      <p className="truncate text-xs text-muted" title={label}>{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-text">{value}</p>
      {hint ? (
        onHintClick ? (
          <button type="button" onClick={onHintClick} className="mt-1 block max-w-full truncate text-left text-[11px] leading-4 text-muted hover:text-accent">{hint}</button>
        ) : (
          <p className="mt-1 truncate text-[11px] leading-4 text-muted" title={hint}>{hint}</p>
        )
      ) : null}
    </div>
  );
}

export function SettingsUsagePage() {
  // Nothing is counted until the user turns 「사용량·비용 집계」 on; rows outside on-intervals are never included.
  const today = localDay(new Date());
  const [range, setRange] = useState<Range>('all');
  const [customFrom, setCustomFrom] = useState(() => localDay(new Date(Date.now() - 6 * 86_400_000)));
  const [customTo, setCustomTo] = useState(today);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [metric, setMetric] = useState<Metric>('tokens');
  const [groupBy, setGroupBy] = useState<GroupBy>('models');
  const [mode, setMode] = useState<ChartMode>('daily');
  // 대화방 → 질문 → 작업 drill-down; chart and table below follow the same focus.
  const [focusSession, setFocusSession] = useState<string | null>(null);
  const [focusTurn, setFocusTurn] = useState<string | null>(null);
  const [tab, setTab] = useState<'sessions' | 'turns'>('sessions');
  const [sort, setSort] = useState<Sort>('recent');
  const [showZero, setShowZero] = useState(false);
  const [focusNotice, setFocusNotice] = useState<string | null>(null);
  const chartRef = useRef<HTMLElement>(null);
  const [data, setData] = useState<LlmUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const query = useMemo<LlmUsageRangeQuery | null>(() => {
    if (range !== 'custom') return { days: range };
    return customFrom && customTo ? { from: customFrom, to: customTo } : null;
  }, [range, customFrom, customTo]);

  const load = useCallback(async () => {
    if (!query) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchLlmUsageSummary(query));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  const tracking = data?.tracking;
  const hasData = Boolean(tracking?.periods.length);
  const message = trackingMessage(tracking);
  const minDay = tracking?.first_started_at ? localDay(new Date(tracking.first_started_at)) : undefined;
  const overYear = range === 'custom' && Boolean(customFrom && customTo)
    && (Date.parse(customTo) - Date.parse(customFrom)) / 86_400_000 + 1 > 366;
  const toggle = useCallback(async (enabled: boolean) => {
    setSwitchBusy(true);
    setError(null);
    try {
      await setLlmUsageTracking(enabled);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitchBusy(false);
    }
  }, [load]);
  const label = (key: string) => (groupBy === 'purposes' ? purposeLabel(key) : key);

  const format = metric === 'tokens' ? formatTokens : formatUsd;
  const metricWord = metric === 'tokens' ? '토큰' : '비용';
  const pickTotals = useCallback((t: LlmUsageTotals) => (metric === 'tokens' ? t.total_tokens : t.cost_usd), [metric]);
  const rows = data && groupBy !== 'sessions' ? data[groupBy] : [];
  const zeroRows = rows.filter((r) => r.total_tokens === 0 && r.cost_usd === 0);
  const visibleRows = showZero ? rows : rows.filter((r) => r.total_tokens > 0 || r.cost_usd > 0);

  const sessionTitles = useMemo(() => new Map((data?.sessions ?? []).map((s) => [s.session_id, s.session_title])), [data]);
  const seriesLabel = useCallback((key: string) => {
    if (groupBy === 'purposes') return purposeLabel(key);
    if (groupBy === 'sessions') return sessionName(key || undefined, sessionTitles.get(key));
    return key;
  }, [groupBy, sessionTitles]);

  const series = useMemo<Series[]>(() => {
    if (!data) return [];
    const pick = (p?: { tokens: number; cost_usd: number }) => (p ? (metric === 'tokens' ? p.tokens : p.cost_usd) : 0);
    const sums = new Map<string, number>();
    for (const d of data.daily) for (const [k, p] of Object.entries(d[groupBy] ?? {})) sums.set(k, (sums.get(k) ?? 0) + pick(p));
    const ranked = [...sums].map(([key, total]) => ({ key, total })).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
    const top = ranked.slice(0, MAX_SERIES);
    const rest = new Set(ranked.slice(MAX_SERIES).map((r) => r.key));
    const out: Series[] = top.map((r, i) => ({
      key: r.key,
      label: seriesLabel(r.key),
      color: PALETTE[i % PALETTE.length],
      total: r.total,
      values: data.daily.map((d) => pick(d[groupBy]?.[r.key])),
    }));
    if (rest.size) {
      const values = data.daily.map((d) => Object.entries(d[groupBy] ?? {}).reduce((s, [k, p]) => s + (rest.has(k) ? pick(p) : 0), 0));
      out.push({ key: `\u0000${OTHER_KEY}`, label: `${OTHER_KEY} ${rest.size}개`, color: PALETTE[PALETTE.length - 1], values, total: values.reduce((a, b) => a + b, 0) });
    }
    return out;
  }, [data, groupBy, metric, seriesLabel]);

  // ---- drill-down focus ----
  const turn = useMemo(() => (focusTurn ? data?.turns?.find((t) => turnKeyOf(t) === focusTurn) ?? null : null), [data, focusTurn]);
  const sessionId = turn ? turn.session_id ?? null : focusSession;
  const session = useMemo(() => (sessionId ? data?.sessions?.find((s) => s.session_id === sessionId) ?? null : null), [data, sessionId]);
  const level: 0 | 1 | 2 = turn ? 2 : session ? 1 : 0;
  const sessionTurns = useMemo(() => (sessionId
    ? (data?.turns ?? []).filter((t) => t.session_id === sessionId).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
    : []), [data, sessionId]);

  const goRoot = useCallback(() => { setFocusSession(null); setFocusTurn(null); setFocusNotice(null); }, []);
  const openSession = useCallback((id: string) => { setFocusSession(id); setFocusTurn(null); setFocusNotice(null); }, []);
  const openTurn = useCallback((t: LlmUsageTurn) => { setFocusSession(t.session_id ?? null); setFocusTurn(turnKeyOf(t)); setFocusNotice(null); }, []);
  /** 묶기 only shapes the overview chart, so picking one while drilled in returns to the overview. */
  const pickGroupBy = useCallback((g: GroupBy) => { setGroupBy(g); goRoot(); }, [goRoot]);
  // After a period change / refresh, drop a focus the new data no longer contains instead of keeping it
  // hidden (it used to silently fall back and then reappear on the next period change).
  useEffect(() => {
    if (!data) return;
    if (focusSession && !(data.sessions ?? []).some((s) => s.session_id === focusSession)) {
      setFocusSession(null);
      setFocusTurn(null);
      setFocusNotice('선택한 기간에는 보던 대화방이 없어 전체 화면으로 돌아왔습니다.');
    } else if (focusTurn && !(data.turns ?? []).some((t) => turnKeyOf(t) === focusTurn)) {
      setFocusTurn(null);
      setFocusNotice('선택한 기간에는 보던 질문이 없어 대화방 화면으로 돌아왔습니다.');
    }
  }, [data, focusSession, focusTurn]);
  useEffect(() => {
    if (focusSession || focusTurn) chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focusSession, focusTurn]);

  const questionBars = useMemo<Bar[]>(() => sessionTurns.map((t) => {
    const byPurpose = new Map<string, number>();
    const calls = t.calls ?? [];
    if (calls.length) {
      for (const c of calls) byPurpose.set(c.purpose, (byPurpose.get(c.purpose) ?? 0) + (metric === 'tokens' ? c.input_tokens + c.output_tokens : c.cost_usd));
    } else {
      byPurpose.set(t.purposes[0] ?? 'chat', pickTotals(t));
    }
    return {
      id: turnKeyOf(t),
      // Same basis as the table/breadcrumb: N-th message of the conversation (server-provided).
      label: t.question_no ? `#${t.question_no}` : '–',
      title: t.question || '(질문 내용을 찾을 수 없음)',
      detail: `${formatStamp(t.started_at)} · 작업 ${t.requests.toLocaleString()}회`,
      segments: [...byPurpose].map(([p, v]) => ({ key: p, label: purposeLabel(p), color: purposeColor(p), value: v })),
    };
  }), [sessionTurns, metric, pickTotals]);

  const callBars = useMemo<Bar[]>(() => (turn?.calls ?? []).map((c, i) => ({
    id: `${c.started_at}-${i}`,
    label: String(i + 1),
    title: `${i + 1}번째 작업 · ${purposeLabel(c.purpose)}${c.failed ? ' (실패)' : ''}`,
    detail: `${c.model} · ${formatDuration(c.duration_ms)}`,
    segments: metric === 'tokens'
      ? [
          { key: 'cached', label: '캐시 읽기', color: '#c7d2fe', value: c.cached_tokens },
          { key: 'input', label: '새 입력', color: '#6366f1', value: Math.max(0, c.input_tokens - c.cached_tokens) },
          { key: 'output', label: '출력', color: '#f59e0b', value: c.output_tokens },
        ]
      : [{ key: c.purpose, label: purposeLabel(c.purpose), color: purposeColor(c.purpose), value: c.cost_usd }],
  })), [turn, metric]);

  const barLegend = (bars: Bar[]) => {
    const seen = new Map<string, { key: string; label: string; color: string; total: number }>();
    for (const b of bars) for (const s of b.segments) {
      const e = seen.get(s.key) ?? { key: s.key, label: s.label, color: s.color, total: 0 };
      e.total += s.value;
      seen.set(s.key, e);
    }
    return [...seen.values()];
  };

  const focusTotals: (LlmUsageTotals & { turns?: number }) | null = turn ?? (session ? { ...session, turns: session.turn_count } : null);
  const currentTurnNo = turn?.question_no;
  const sessionsList = data?.sessions ?? [];
  const turnsList = data?.turns ?? [];

  const totals = data?.totals;
  const dates = data?.daily.map((d) => d.date) ?? [];
  const costHint = totals
    ? [
        totals.billed_cost_usd > 0 ? `실제 청구 ${formatUsd(totals.billed_cost_usd)}` : null,
        totals.estimated_cost_usd > 0 ? `단가표 추정 ${formatUsd(totals.estimated_cost_usd)}` : null,
        totals.unpriced_requests > 0 ? `단가 없음 ${totals.unpriced_requests}건 제외` : null,
      ].filter(Boolean).join(' · ')
    : undefined;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-5 pr-12">
        <h2 className="text-xl font-semibold">사용량·비용</h2>
        <p className="mt-1 text-sm text-muted">
          이 PC의 MY Agent가 보낸 모델 요청만 집계합니다. 대화·승인 판단·이미지·영상·임베딩 요청이 모두 들어갑니다.
          같은 API 키를 다른 프로그램에서 쓴 사용량은 포함되지 않습니다.
        </p>
      </header>

      <section className="mb-4 flex items-center gap-4 rounded-xl border border-line bg-panel px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text">사용량·비용 집계 <span className="ml-1 font-normal text-muted">· {message.title}</span></p>
          {message.body ? <p className="mt-0.5 text-xs text-muted">{message.body}</p> : null}
        </div>
        <TrackingSwitch on={Boolean(tracking?.enabled)} disabled={switchBusy || !tracking} onChange={(v) => void toggle(v)} />
      </section>

      {error ? <p className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-500">{error}</p> : null}

      {hasData ? (<>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented<Range> label="기간" value={range} onChange={setRange} options={RANGE_OPTIONS} />
        {range === 'custom' ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            <input
              type="date"
              aria-label="시작일"
              value={customFrom}
              min={minDay}
              max={customTo || today}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-md border border-line bg-ink px-2 py-1 text-text"
            />
            ~
            <input
              type="date"
              aria-label="종료일"
              value={customTo}
              min={customFrom || minDay}
              max={today}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-md border border-line bg-ink px-2 py-1 text-text"
            />
            <span className={`ml-1 ${overYear ? 'text-amber-500' : ''}`}>
              {overYear ? '1년이 넘어 종료일 기준 최근 1년만 표시합니다' : '최대 1년'}
            </span>
          </span>
        ) : null}
        <Segmented label="기준" value={metric} onChange={setMetric} options={[{ value: 'tokens', label: '토큰' }, { value: 'cost', label: '비용' }]} />
        <Segmented
          label="묶기"
          value={groupBy}
          onChange={pickGroupBy}
          options={(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => ({ value: g, label: GROUP_LABEL[g].short }))}
        />
        <button type="button" onClick={() => void load()} disabled={loading} className="ml-auto rounded-lg border border-line px-3 py-1 text-xs text-muted hover:text-text disabled:opacity-50">
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
      </div>

      {level > 0 ? (
        <p className="-mt-2 mb-4 text-[11px] text-muted">
          {level === 2 ? '질문 하나' : '대화방 하나'}를 보고 있습니다. 기간과 토큰/비용은 이 화면에도 적용되고, 묶기를 누르면 전체 화면으로 돌아갑니다.
        </p>
      ) : null}
      {focusNotice ? (
        <p className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs">
          <span className="flex-1">{focusNotice}</span>
          <button type="button" onClick={() => setFocusNotice(null)} className="text-muted hover:text-text">닫기</button>
        </p>
      ) : null}

      {data?.logging_disabled ? (
        <p className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          사용량 기록이 꺼져 있습니다(MY_AGENT_LLM_USAGE_LOG=0). 꺼져 있던 기간은 비어 보입니다.
        </p>
      ) : null}

      {data?.legacy_mismatch_dates?.length ? (
        <p className="mb-4 rounded-xl border border-line px-4 py-2 text-xs text-muted" title={data.legacy_mismatch_dates.join(', ')}>
          일부 예전 기록({data.legacy_mismatch_dates.length}일)은 새 저장소로 옮기는 과정에서 집계가 조금 다를 수 있습니다. 새 기록에는 영향이 없습니다.
        </p>
      ) : null}

      {totals ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="총 토큰" value={formatTokens(totals.total_tokens)} hint={`입력 ${formatTokens(totals.input_tokens)} · 출력 ${formatTokens(totals.output_tokens)}`} />
          <StatCard label="총 비용" value={formatUsd(totals.cost_usd)} hint={costHint || undefined} />
          <StatCard
            label="AI 작업 수"
            value={totals.requests.toLocaleString()}
            hint={[
              data?.sessions_total ? `대화방 ${data.sessions_total.toLocaleString()}개` : null,
              data?.turns_total ? `질문 ${data.turns_total.toLocaleString()}개` : null,
              totals.failed_requests ? `실패·중단 ${totals.failed_requests}회 포함` : null,
            ].filter(Boolean).join(' · ') || undefined}
          />
          <StatCard
            label={`${totals.cache_savings_usd < 0 ? '캐시 저장 추가 비용' : '캐시로 아낀 금액'}${totals.cache_savings_estimated_requests ? ' (추정)' : ''}`}
            value={formatUsd(Math.abs(totals.cache_savings_usd))}
            hint={data?.cache_requests_total ? `캐시 적용 ${data.cache_requests_total.toLocaleString()}건` : undefined}
          />
        </div>
      ) : null}

      <section ref={chartRef} aria-busy={loading} className={`mb-4 scroll-mt-4 rounded-2xl border border-line bg-panel p-5 shadow-sm transition-opacity ${loading ? 'opacity-60' : ''}`}>
        <Breadcrumb
          items={[
            { label: '전체 대화방', onClick: level > 0 ? goRoot : undefined },
            ...(level > 0 ? [{
              label: sessionName(sessionId ?? undefined, session?.session_title ?? turn?.session_title),
              onClick: level === 2 && sessionId ? () => openSession(sessionId) : undefined,
            }] : []),
            ...(turn ? [{ label: `${currentTurnNo ? `#${currentTurnNo} ` : ''}${turn.question || '질문'}` }] : []),
          ]}
        />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ChartLine size={18} className="text-accent" />
          <h3 className="text-sm font-semibold text-text">
            {level === 0 ? `${mode === 'cumulative' ? '누적' : '일별'} ${metricWord}` : level === 1 ? `질문별 ${metricWord}` : `작업별 ${metricWord}`}
          </h3>
          {data && level === 0 ? <span className="text-xs text-muted">{data.range.from} ~ {data.range.to}</span> : null}
          {level === 0 ? (
            <span className="ml-auto">
              <Segmented
                label="차트 모양"
                value={mode}
                onChange={setMode}
                options={[{ value: 'daily', label: '일별' }, { value: 'cumulative', label: '누적' }]}
              />
            </span>
          ) : (
            <button type="button" onClick={level === 2 && sessionId ? () => openSession(sessionId) : goRoot} className="ml-auto rounded-lg border border-line px-3 py-1 text-xs text-muted hover:text-text">
              ← {level === 2 && sessionId ? '질문 목록' : '전체 대화방'}
            </button>
          )}
        </div>
        {focusTotals ? (
          <p className="mb-3 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-line/20 px-3 py-2 text-xs text-muted tabular-nums">
            {focusTotals.turns !== undefined ? <span>질문 <b className="font-medium text-text">{focusTotals.turns.toLocaleString()}개</b></span> : null}
            <span>작업 <b className="font-medium text-text">{focusTotals.requests.toLocaleString()}회</b></span>
            <span>토큰 <b className="font-medium text-text">{formatTokens(focusTotals.total_tokens)}</b></span>
            <span>비용 <b className="font-medium text-text">{formatUsd(focusTotals.cost_usd)}</b></span>
            <span>캐시 비율 <b className="font-medium text-text">{cacheRatioText(focusTotals)}</b></span>
            <span className={savingsText(focusTotals.cache_savings_usd).cls}>캐시 {savingsText(focusTotals.cache_savings_usd).text}</span>
            {turn ? <span>소요 <b className="font-medium text-text">{formatDuration(Date.parse(turn.finished_at) - Date.parse(turn.started_at))}</b></span> : null}
          </p>
        ) : null}
        {level === 1 ? (
          questionBars.length ? (
            <>
              <StackedBars bars={questionBars} format={format} onPick={(i) => openTurn(sessionTurns[i])} />
              <Legend items={barLegend(questionBars)} format={format} />
              <p className="mt-2 text-[11px] text-muted">막대 하나가 질문 1개이고, 색은 작업 종류입니다. 막대를 누르면 그 질문의 작업 내역으로 들어갑니다.</p>
            </>
          ) : (
            <p className="py-16 text-center text-sm text-muted">이 대화방에는 질문 단위로 기록된 작업이 없습니다.</p>
          )
        ) : level === 2 ? (
          callBars.length ? (
            <>
              <StackedBars bars={callBars} format={format} />
              <Legend items={barLegend(callBars)} format={format} />
              <p className="mt-2 text-[11px] text-muted">{metric === 'tokens'
                ? '막대 하나가 작업(AI 호출) 1회입니다. 연한 부분이 캐시에서 읽은 입력, 진한 부분이 새로 보낸 입력, 주황색이 출력입니다.'
                : '막대 하나가 작업(AI 호출) 1회이고, 색은 작업 종류입니다.'}</p>
            </>
          ) : (
            <p className="py-16 text-center text-sm text-muted">작업 내역이 없습니다.</p>
          )
        ) : series.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted">{loading
              ? '불러오는 중…'
              : metric === 'cost' && (totals?.requests ?? 0) > 0
                ? '비용을 계산할 수 있는 요청이 없습니다. 청구액도 단가 정보도 없는 요청은 비용에서 빠집니다.'
                : '이 기간에 기록된 사용량이 없습니다.'}</p>
        ) : (
          <>
            <UsageChart dates={dates} series={series} mode={mode} format={format} />
            <Legend
              format={format}
              items={series.map((s) => ({
                key: s.key,
                label: s.label,
                color: s.color,
                total: s.total,
                onClick: groupBy === 'sessions' && s.key && !s.key.startsWith('\u0000') && sessionTitles.has(s.key) ? () => openSession(s.key) : undefined,
              }))}
            />
          </>
        )}
        {level === 0 && series.length > 0 && dates.length > 1 ? (
          <p className="mt-2 text-[11px] text-muted">{mode === 'cumulative'
            ? '맨 위 선이 그날까지 쌓인 합계, 띠의 두께가 각 항목이 쌓은 몫입니다.'
            : '맨 위 선이 그날 합계, 띠의 두께가 각 항목의 몫입니다.'}{groupBy === 'sessions' ? ' 아래 범례의 대화방 이름을 누르면 그 대화방으로 들어갑니다.' : ''}</p>
        ) : null}
      </section>

      {level === 0 && rows.length ? (
        <section className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-sm font-semibold text-text">{GROUP_LABEL[groupBy].short} 합계</h3>
            {zeroRows.length ? (
              <button type="button" onClick={() => setShowZero((v) => !v)} className="ml-auto text-xs text-muted hover:text-text">
                {showZero ? '토큰·비용 0인 항목 숨기기' : `토큰·비용 0인 항목 ${zeroRows.length}개 보기`}
              </button>
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs tabular-nums">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-medium">{GROUP_LABEL[groupBy].column}</th>
                  <th className="py-2 pr-3 text-right font-medium">작업</th>
                  <th className="py-2 pr-3 text-right font-medium">입력</th>
                  <th className="py-2 pr-3 text-right font-medium">출력</th>
                  <th className="py-2 pr-3 text-right font-medium">캐시 읽기</th>
                  <th className="py-2 pr-3 text-right font-medium" title="입력 토큰 중 캐시에서 읽은 비율">캐시 비율</th>
                  <th className="py-2 pr-3 text-right font-medium">비용</th>
                  <th className="py-2 text-right font-medium">작업당 평균</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr key={r.key} className="border-b border-line/60 last:border-0">
                    <td className="max-w-64 truncate py-2 pr-3 text-text" title={r.key}>{label(r.key)}</td>
                    <td className="py-2 pr-3 text-right">{r.requests.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right">{formatTokens(r.input_tokens)}</td>
                    <td className="py-2 pr-3 text-right">{formatTokens(r.output_tokens)}</td>
                    <td className="py-2 pr-3 text-right">{formatTokens(r.cached_tokens)}</td>
                    <td
                      className="py-2 pr-3 text-right"
                      title={r.input_tokens > 0
                        ? `입력 ${r.input_tokens.toLocaleString()} 중 캐시 읽기 ${r.cached_tokens.toLocaleString()}, 캐시 저장 ${(r.cache_write_tokens ?? 0).toLocaleString()}`
                        : undefined}
                    >
                      {r.input_tokens > 0 ? formatCacheRatio(r.cached_tokens / r.input_tokens) : '-'}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <CostCell t={r} />
                    </td>
                    <td className="py-2 text-right">{r.requests ? formatUsd(r.cost_usd / r.requests) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] leading-4 text-muted">
            OpenRouter처럼 응답에 청구액을 주는 경우 실제 청구액을, 그 외에는 모델 목록의 단가로 계산한 추정액을 씁니다.
            날짜는 이 PC의 시간대 기준이며, 재시도한 작업도 각각 1회로 셉니다.
          </p>
        </section>
      ) : null}

      {data && level === 0 && groupBy === 'sessions' && (sessionsList.length || turnsList.length) ? (
        <section className="mt-4 rounded-2xl border border-line bg-panel p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text">대화방·질문별 사용량</h3>
            <Segmented
              label="목록"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'sessions', label: `대화방별 ${(data.sessions_total ?? sessionsList.length).toLocaleString()}개` },
                { value: 'turns', label: `전체 질문 ${(data.turns_total ?? turnsList.length).toLocaleString()}개` },
              ]}
            />
            <span className="ml-auto"><Segmented label="정렬" value={sort} onChange={setSort} options={SORT_OPTIONS} /></span>
          </div>
          {tab === 'sessions' ? (
            <SessionsTable key={`s-${data.range.from}-${data.range.to}-${sort}`} items={sortItems(sessionsList, sort, (s) => s.last_at)} onOpen={(s) => openSession(s.session_id)} />
          ) : (
            <QuestionsTable key={`t-${data.range.from}-${data.range.to}-${sort}`} items={sortItems(turnsList, sort, (t) => t.started_at)} showSession onOpen={openTurn} />
          )}
          <p className="mt-3 text-[11px] leading-4 text-muted">
            대화방 → 질문 → 작업 순으로 눌러 들어가면 위 그래프도 함께 바뀝니다. 작업은 질문 하나에 답하는 동안 부른 AI 호출(에이전트 단계, 승인 판단, 이미지·영상 생성 등) 1회입니다.
            {tab === 'sessions' && (data.unsessioned_requests ?? 0) > 0 ? ` 대화방 밖에서 부른 작업(연결 테스트 등) ${data.unsessioned_requests!.toLocaleString()}회는 위 합계에만 들어갑니다.` : ''}
            {tab === 'turns' && (data.untracked_turn_requests ?? 0) > 0 ? ` 질문 정보가 기록되기 전의 작업 ${data.untracked_turn_requests!.toLocaleString()}회는 질문 목록에 나오지 않고, 대화방 합계와 위 합계에만 들어갑니다.` : ''}
            {tab === 'turns' && (data.turns_total ?? 0) > turnsList.length ? ` 최근 ${turnsList.length.toLocaleString()}개 질문까지 표시합니다.` : ''}
          </p>
        </section>
      ) : null}

      {level === 1 && session ? (
        <section className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text">이 대화방의 질문 <span className="font-normal text-muted">{sessionTurns.length.toLocaleString()}개</span></h3>
            <span className="ml-auto"><Segmented label="정렬" value={sort} onChange={setSort} options={SORT_OPTIONS} /></span>
          </div>
          {sessionTurns.length ? (
            <QuestionsTable key={`st-${session.session_id}-${sort}`} items={sortItems(sessionTurns, sort, (t) => t.started_at)} showSession={false} onOpen={openTurn} />
          ) : null}
          <p className="mt-3 text-[11px] leading-4 text-muted">
            줄을 누르면 그 질문에서 일어난 작업을 순서대로 봅니다.
            {session.untracked_requests > 0 ? ` 질문 정보가 기록되기 전의 작업 ${session.untracked_requests.toLocaleString()}회는 질문 목록에 없고 이 대화방 합계에만 들어갑니다.` : ''}
            {session.turn_count > sessionTurns.length ? ` 최근 질문만 불러와서 ${(session.turn_count - sessionTurns.length).toLocaleString()}개는 목록에 없습니다.` : ''}
          </p>
        </section>
      ) : null}

      {level === 2 && turn ? (
        <section className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
          <h3 className="mb-1 text-sm font-semibold text-text">이 질문의 작업 <span className="font-normal text-muted">{(turn.calls_total ?? turn.requests).toLocaleString()}회</span></h3>
          {turn.question ? <p className="mb-3 line-clamp-3 text-xs text-muted" title={turn.question}>{turn.question}</p> : null}
          <CallsTable calls={turn.calls ?? []} />
          <p className="mt-3 text-[11px] leading-4 text-muted">
            시간순입니다. 캐시 읽기에 마우스를 올리면 캐시 저장량을 볼 수 있습니다.
            {(turn.calls_total ?? 0) > (turn.calls?.length ?? 0) ? ` 처음 ${(turn.calls?.length ?? 0).toLocaleString()}회까지 표시합니다.` : ''}
          </p>
        </section>
      ) : null}
      </>) : null}
    </div>
  );
}
