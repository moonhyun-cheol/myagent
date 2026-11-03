import { ArrowClockwise, CheckCircle, FirstAidKit, Warning, WarningCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { fetchProblemHistory, type ProblemHistory, type ProblemSeverity } from '../api/myAgentClient';
import { canCollectDiagnostics, collectDiagnosticsBundle } from '../lib/appPreferences';
import { inAppBrowserOpenExternal } from '../lib/inAppBrowserBridge';

/** Installer page in the PC's default browser (shell), or a new tab outside the desktop app. */
function openDownloadPage(url: string): void {
  if (inAppBrowserOpenExternal(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 「오늘 14:02」「어제 09:10」「10월 12일 14:02」 in the PC's local time. */
function formatProblemTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((day(now) - day(at)) / 86_400_000);
  if (diffDays === 0) return `오늘 ${hm}`;
  if (diffDays === 1) return `어제 ${hm}`;
  return `${at.getMonth() + 1}월 ${at.getDate()}일 ${hm}`;
}

const SEVERITY_STYLE: Record<ProblemSeverity, { label: string; text: string; Icon: typeof Warning }> = {
  error: { label: '도움 필요', text: 'text-danger', Icon: WarningCircle },
  warn: { label: '확인 권장', text: 'text-warning', Icon: Warning },
  recovered: { label: '자동 해결', text: 'text-accent', Icon: CheckCircle },
};

export function SettingsTroubleshootSection() {
  const [history, setHistory] = useState<ProblemHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const desktop = canCollectDiagnostics();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHistory(await fetchProblemHistory(14));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const status = history?.status;
  // Cards are only for problems the user may need to act on; auto-recovered ones are a single line.
  const actionable = history?.groups.filter((g) => g.severity !== 'recovered') ?? [];
  const recovered = history?.groups.filter((g) => g.severity === 'recovered') ?? [];
  const HeadlineIcon = status === 'attention' ? Warning : CheckCircle;
  const headlineTone = status === 'attention' ? 'text-warning' : 'text-accent';

  return (
    <section className="mb-6 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm" aria-labelledby="settings-troubleshoot-title">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <FirstAidKit size={18} className="text-accent" />
            <h3 id="settings-troubleshoot-title" className="text-sm font-semibold text-text">문제 해결</h3>
          </div>
          <p className="text-xs text-muted">최근 14일 동안 프로그램이 꺼지거나 멈췄던 기록을 정리해 보여 줍니다.</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-panel px-3 py-1.5 text-sm text-text hover:border-accent disabled:cursor-wait disabled:opacity-45"
        >
          <ArrowClockwise size={14} className={loading ? 'animate-spin' : undefined} />
          새로 확인
        </button>
      </div>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-border bg-panel/50 px-4 py-3 text-sm text-danger">
          기록을 불러오지 못했습니다. ({error})
        </p>
      ) : null}

      {history ? (
        <div className="space-y-3">
          <p className={`flex items-center gap-2 text-sm font-medium ${headlineTone}`} role="status">
            <HeadlineIcon size={18} weight="fill" />
            {history.headline}
          </p>

          {actionable.length > 0 ? (
            <ul className="space-y-2">
              {actionable.map((group) => {
                const style = SEVERITY_STYLE[group.severity];
                return (
                  <li key={group.kind} className="rounded-xl border border-border bg-panel/50 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex items-start gap-2">
                        <style.Icon size={16} weight="fill" className={`mt-0.5 shrink-0 ${style.text}`} />
                        <span>
                          <span className="block text-sm font-medium text-text">{group.title}</span>
                          <span className="mt-0.5 block text-xs text-muted">
                            {group.count === 1
                              ? formatProblemTime(group.last_at)
                              : `${group.count}번 · 마지막 ${formatProblemTime(group.last_at)}`}
                          </span>
                        </span>
                      </span>
                      <span className={`shrink-0 text-[11px] font-semibold ${style.text}`}>{style.label}</span>
                    </div>
                    {group.cause ? <p className="mt-2 pl-6 text-xs leading-5 text-text">{group.cause}</p> : null}
                    <p className={`${group.cause ? 'mt-1' : 'mt-2'} pl-6 text-xs leading-5 text-text/85`}>{group.advice}</p>
                    {group.download_url ? (
                      <div className="mt-2 pl-6">
                        <button
                          type="button"
                          onClick={() => openDownloadPage(group.download_url!)}
                          className="inline-flex items-center rounded-lg border border-border bg-panel px-3 py-1 text-xs font-medium text-text hover:border-accent"
                        >
                          설치 파일 받기
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {recovered.length > 0 ? (
            <p className="flex items-start gap-2 text-xs leading-5 text-muted">
              <CheckCircle size={14} weight="fill" className="mt-0.5 shrink-0 text-accent" />
              <span>
                {actionable.length > 0 ? '그 밖에 자동으로 해결된 일: ' : '자동으로 해결된 일: '}
                {recovered.map((g) => `${g.title} ${g.count}번`).join(', ')}. 따로 할 일은 없습니다.
              </span>
            </p>
          ) : null}

          {history.recent.length > 0 ? (
            <div>
              <button
                type="button"
                onClick={() => setShowRecent((v) => !v)}
                aria-expanded={showRecent}
                className="text-xs text-muted underline-offset-2 hover:text-text hover:underline"
              >
                {showRecent ? '시간순 기록 숨기기' : `시간순 기록 보기 (${history.recent.length})`}
              </button>
              {showRecent ? (
                <ol className="mt-2 space-y-1 rounded-xl border border-border bg-panel/50 px-4 py-3 text-xs">
                  {history.recent.map((event, index) => (
                    <li key={`${event.at}-${event.kind}-${index}`} className="flex gap-3">
                      <span className="w-28 shrink-0 tabular-nums text-muted">{formatProblemTime(event.at)}</span>
                      <span className={SEVERITY_STYLE[event.severity].text}>{event.title}</span>
                      {event.cause ?? event.detail ? (
                        <span className="min-w-0 truncate text-muted" title={event.detail ?? event.cause}>{event.cause ?? event.detail}</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : !error ? (
        <p className="text-sm text-muted">기록을 확인하는 중…</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-xs leading-5 text-muted">
          해결되지 않으면 기록을 담당자에게 보내 주세요. 대화 내용과 API 키는 들어가지 않습니다.
          {desktop ? null : ' (데스크톱 앱에서만 저장할 수 있습니다)'}
        </span>
        <button
          type="button"
          disabled={!desktop}
          onClick={() => collectDiagnosticsBundle()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
        >
          담당자에게 보낼 기록 저장
        </button>
      </div>
    </section>
  );
}
