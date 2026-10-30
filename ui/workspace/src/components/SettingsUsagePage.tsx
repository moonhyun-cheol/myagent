import { ChartLine } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchLlmUsageSummary, setLlmUsageTracking, type LlmUsageCacheRequest, type LlmUsageRangeQuery, type LlmUsageSummary, type LlmUsageTracking } from '../api/myAgentClient';

type Metric = 'tokens' | 'cost';
type GroupBy = 'models' | 'providers' | 'purposes';
type Range = 7 | 30 | 90 | 'all' | 'custom';

const GROUP_LABEL: Record<GroupBy, { short: string; column: string }> = {
  models: { short: '모델별', column: '모델' },
  providers: { short: '프로바이더별', column: '프로바이더' },
  purposes: { short: '용도별', column: '용도' },
};

const PURPOSE_LABEL: Record<string, string> = {
  chat: '대화·에이전트',
  approval: '승인 판단',
  image: '이미지 생성',
  video: '영상 생성',
  embedding: '임베딩',
};

const pad2 = (n: number) => String(n).padStart(2, '0');

function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatSince(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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

const CACHE_PAGE = 20;

function CacheRequestsTable({ items, total }: { items: LlmUsageCacheRequest[]; total: number }) {
  const [shown, setShown] = useState(CACHE_PAGE);
  if (!items.length) return null;
  const visible = items.slice(0, shown);
  return (
    <section className="mt-4 rounded-2xl border border-line bg-panel p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-text">캐시 할인 내역 <span className="font-normal text-muted">{total.toLocaleString()}건</span></h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-3 font-medium">시각</th>
              <th className="py-2 pr-3 font-medium">모델</th>
              <th className="py-2 pr-3 text-right font-medium">캐시 읽기</th>
              <th className="py-2 pr-3 text-right font-medium">캐시 저장</th>
              <th className="py-2 text-right font-medium">할인</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={`${r.started_at}-${i}`} className="border-b border-line/60 last:border-0">
                <td className="whitespace-nowrap py-2 pr-3">{formatSince(r.started_at)}</td>
                <td className="max-w-64 truncate py-2 pr-3 text-text" title={r.model}>{r.model}</td>
                <td className="py-2 pr-3 text-right">{r.cached_tokens ? formatTokens(r.cached_tokens) : '-'}</td>
                <td className="py-2 pr-3 text-right">{r.cache_write_tokens ? formatTokens(r.cache_write_tokens) : '-'}</td>
                <td className={`whitespace-nowrap py-2 text-right ${r.savings_usd < 0 ? 'text-amber-500' : 'text-text'}`}>
                  {r.savings_usd < 0 ? `+${formatUsd(-r.savings_usd)} 저장 비용` : r.savings_usd > 0 ? `−${formatUsd(r.savings_usd)}` : '-'}
                  {r.estimated && r.savings_usd !== 0 ? <span className="ml-1 text-muted">추정</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items.length > shown ? (
        <button type="button" onClick={() => setShown((n) => n + CACHE_PAGE * 5)} className="mt-3 rounded-lg border border-line px-3 py-1 text-xs text-muted hover:text-text">
          더 보기
        </button>
      ) : null}
      <p className="mt-3 text-[11px] leading-4 text-muted">
        캐시를 읽거나 저장한 요청만 보여 줍니다. 캐시에 처음 저장할 때는 정가보다 비싸 「저장 비용」으로, 다시 읽을 때는 할인으로 표시됩니다.
        {total > items.length ? ` 최근 ${items.length.toLocaleString()}건까지 표시합니다.` : ''}
      </p>
    </section>
  );
}

type ChartMode = 'line' | 'stacked' | 'cumulative';

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
  const daySum = dates.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const cumulative = daySum.reduce<number[]>((acc, v, i) => { acc.push((acc[i - 1] ?? 0) + v); return acc; }, []);
  const maxRaw = mode === 'line'
    ? Math.max(0, ...series.flatMap((s) => s.values))
    : mode === 'stacked' ? Math.max(0, ...daySum) : Math.max(0, ...cumulative);
  const yMax = niceCeil(maxRaw);
  const x = (i: number) => L + (n <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / yMax);
  const pts = (vals: number[]) => vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const labelEvery = Math.max(1, Math.ceil(n / 7));

  const stackedLayers = useMemo(() => {
    if (mode !== 'stacked') return [];
    const base = new Array<number>(n).fill(0);
    return series.map((s) => {
      const lower = [...base];
      const upper = base.map((b, i) => b + s.values[i]);
      for (let i = 0; i < n; i += 1) base[i] = upper[i];
      return { s, lower, upper };
    });
  }, [mode, series, n]);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="일별 사용량 차트" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-line" strokeWidth={1} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="currentColor" className="text-muted">{format(t)}</text>
          </g>
        ))}
        {dates.map((d, i) => (i % labelEvery === 0 || i === n - 1 ? (
          <text key={d} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="currentColor" className="text-muted">{d.slice(5)}</text>
        ) : null))}

        {mode === 'line' && series.map((s) => (
          <polyline key={s.key} points={pts(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
        ))}
        {mode === 'stacked' && stackedLayers.map(({ s, lower, upper }) => (
          <polygon
            key={s.key}
            points={`${pts(upper)} ${[...lower].reverse().map((v, ri) => `${x(n - 1 - ri).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}`}
            fill={s.color}
            fillOpacity={0.55}
            stroke={s.color}
            strokeWidth={1}
          />
        ))}
        {mode === 'cumulative' && (
          <>
            <polygon points={`${x(0)},${y(0)} ${pts(cumulative)} ${x(n - 1)},${y(0)}`} fill={PALETTE[0]} fillOpacity={0.15} />
            <polyline points={pts(cumulative)} fill="none" stroke={PALETTE[0]} strokeWidth={2} />
          </>
        )}

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
          <p className="mb-1 font-semibold text-text">{dates[hover]}</p>
          {mode === 'cumulative' ? (
            <p className="text-muted">누적 합계 <span className="float-right ml-3 text-text">{format(cumulative[hover])}</span></p>
          ) : (
            <>
              {series.filter((s) => s.values[hover] > 0).map((s) => (
                <p key={s.key} className="flex items-center gap-2 text-muted">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="min-w-0 flex-1 truncate">{s.key}</span>
                  <span className="text-text">{format(s.values[hover])}</span>
                </p>
              ))}
              <p className="mt-1 border-t border-line pt-1 text-muted">합계 <span className="float-right text-text">{format(daySum[hover])}</span></p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text">{value}</p>
      {hint ? <p className="mt-1 text-[11px] leading-4 text-muted">{hint}</p> : null}
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
  const [mode, setMode] = useState<ChartMode>('stacked');
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
  const label = (key: string) => (groupBy === 'purposes' ? PURPOSE_LABEL[key] ?? key : key);

  const format = metric === 'tokens' ? formatTokens : formatUsd;
  const rows = data ? data[groupBy] : [];
  const series = useMemo<Series[]>(() => {
    if (!data) return [];
    const pick = (p?: { tokens: number; cost_usd: number }) => (p ? (metric === 'tokens' ? p.tokens : p.cost_usd) : 0);
    const ranked = [...data[groupBy]]
      .map((r) => ({ key: r.key, total: metric === 'tokens' ? r.total_tokens : r.cost_usd }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
    const top = ranked.slice(0, MAX_SERIES);
    const rest = new Set(ranked.slice(MAX_SERIES).map((r) => r.key));
    const out: Series[] = top.map((r, i) => ({
      key: groupBy === 'purposes' ? PURPOSE_LABEL[r.key] ?? r.key : r.key,
      color: PALETTE[i % PALETTE.length],
      total: r.total,
      values: data.daily.map((d) => pick(d[groupBy][r.key])),
    }));
    if (rest.size) {
      const values = data.daily.map((d) => Object.entries(d[groupBy]).reduce((s, [k, p]) => s + (rest.has(k) ? pick(p) : 0), 0));
      out.push({ key: OTHER_KEY, color: PALETTE[PALETTE.length - 1], values, total: values.reduce((a, b) => a + b, 0) });
    }
    return out;
  }, [data, groupBy, metric]);

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
          onChange={setGroupBy}
          options={(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => ({ value: g, label: GROUP_LABEL[g].short }))}
        />
        <Segmented
          label="보기"
          value={mode}
          onChange={setMode}
          options={[{ value: 'line', label: '선' }, { value: 'stacked', label: '누적 영역' }, { value: 'cumulative', label: '누적 합계' }]}
        />
        <button type="button" onClick={() => void load()} disabled={loading} className="ml-auto rounded-lg border border-line px-3 py-1 text-xs text-muted hover:text-text disabled:opacity-50">
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
      </div>

      {data?.logging_disabled ? (
        <p className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          사용량 기록이 꺼져 있습니다(MY_AGENT_LLM_USAGE_LOG=0). 꺼져 있던 기간은 비어 보입니다.
        </p>
      ) : null}

      {totals ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="총 토큰" value={formatTokens(totals.total_tokens)} hint={`입력 ${formatTokens(totals.input_tokens)} · 출력 ${formatTokens(totals.output_tokens)}`} />
          <StatCard label="총 비용" value={formatUsd(totals.cost_usd)} hint={costHint || undefined} />
          <StatCard label="요청 수" value={totals.requests.toLocaleString()} hint={totals.failed_requests ? `실패·중단 ${totals.failed_requests}건 포함` : undefined} />
          <StatCard
            label={`${totals.cache_savings_usd < 0 ? '캐시 저장 추가 비용' : '캐시로 아낀 금액'}${totals.cache_savings_estimated_requests ? ' (추정)' : ''}`}
            value={formatUsd(Math.abs(totals.cache_savings_usd))}
            hint={data?.cache_requests_total ? `캐시 사용 요청 ${data.cache_requests_total.toLocaleString()}건 · 아래 내역 참고` : undefined}
          />
        </div>
      ) : null}

      <section className="mb-4 rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <ChartLine size={18} className="text-accent" />
          <h3 className="text-sm font-semibold text-text">
            일별 {metric === 'tokens' ? '토큰' : '비용'} · {mode === 'line' ? '선' : mode === 'stacked' ? '누적 영역' : '누적 합계'}
          </h3>
          {data ? <span className="ml-auto text-xs text-muted">{data.range.from} ~ {data.range.to}</span> : null}
        </div>
        {series.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted">{loading
              ? '불러오는 중…'
              : metric === 'cost' && (totals?.requests ?? 0) > 0
                ? '비용을 계산할 수 있는 요청이 없습니다. 청구액도 단가 정보도 없는 요청은 비용에서 빠집니다.'
                : '이 기간에 기록된 사용량이 없습니다.'}</p>
        ) : (
          <>
            <UsageChart dates={dates} series={series} mode={mode} format={format} />
            {mode !== 'cumulative' ? (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {series.map((s) => (
                  <span key={s.key} className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                    <span className="max-w-56 truncate">{s.key}</span>
                    <span className="text-text">{format(s.total)}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}
        {mode === 'stacked' ? (
          <p className="mt-2 text-[11px] text-muted">맨 위 선이 그날 합계, 띠의 두께가 각 항목의 몫입니다.</p>
        ) : null}
      </section>

      {rows.length ? (
        <section className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-text">{GROUP_LABEL[groupBy].short} 합계</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-medium">{GROUP_LABEL[groupBy].column}</th>
                  <th className="py-2 pr-3 text-right font-medium">요청</th>
                  <th className="py-2 pr-3 text-right font-medium">입력</th>
                  <th className="py-2 pr-3 text-right font-medium">출력</th>
                  <th className="py-2 pr-3 text-right font-medium">캐시 읽기</th>
                  <th className="py-2 pr-3 text-right font-medium">비용</th>
                  <th className="py-2 text-right font-medium">요청당 평균</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-b border-line/60 last:border-0">
                    <td className="max-w-64 truncate py-2 pr-3 text-text" title={r.key}>{label(r.key)}</td>
                    <td className="py-2 pr-3 text-right">{r.requests.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right">{formatTokens(r.input_tokens)}</td>
                    <td className="py-2 pr-3 text-right">{formatTokens(r.output_tokens)}</td>
                    <td className="py-2 pr-3 text-right">{formatTokens(r.cached_tokens)}</td>
                    <td className="py-2 pr-3 text-right">
                      {formatUsd(r.cost_usd)}
                      {r.billed_cost_usd > 0 ? null : r.estimated_cost_usd > 0 ? <span className="ml-1 text-muted">추정</span> : null}
                      {r.unpriced_requests > 0 ? <span className="ml-1 text-amber-500" title={`청구액도 단가 정보도 없는 요청 ${r.unpriced_requests}건은 비용에서 빠졌습니다`}>*</span> : null}
                    </td>
                    <td className="py-2 text-right">{r.requests ? formatUsd(r.cost_usd / r.requests) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] leading-4 text-muted">
            OpenRouter처럼 응답에 청구액을 주는 경우 실제 청구액을, 그 외에는 모델 목록의 단가로 계산한 추정액을 씁니다.
            날짜는 이 PC의 시간대 기준이며, 재시도한 요청도 각각 1건으로 셉니다.
          </p>
        </section>
      ) : null}
      {data?.cache_requests?.length ? (
        <CacheRequestsTable key={`${data.range.from}-${data.range.to}`} items={data.cache_requests} total={data.cache_requests_total ?? data.cache_requests.length} />
      ) : null}
      </>) : null}
    </div>
  );
}
