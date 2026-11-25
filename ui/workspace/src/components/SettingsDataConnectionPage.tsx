import { ArrowsClockwise, Database, UploadSimple, Warning } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import {
  getDataConnections,
  listSshServers,
  registerDatasetExport,
  removeDatasetExport,
  runDatasetExport,
  setDataOperatorMode,
  type DataConnectionItem,
  type DataConnectionOverview,
  type DatasetStatus,
  type SshServerItem,
} from '../api/myAgentClient';

interface SettingsDataConnectionPageProps {
  readOnly: boolean;
  overview: DataConnectionOverview | null;
  onOverviewChange: (next: DataConnectionOverview) => void;
  onOpenSsh: () => void;
}

const STATUS_BADGE: Record<DatasetStatus, string> = {
  ready: 'bg-accent/15 text-accent',
  stale: 'bg-amber-400/15 text-amber-300',
  no_access: 'bg-red-400/15 text-red-300',
  missing: 'bg-line text-muted',
  unreachable: 'bg-line text-muted',
  invalid: 'bg-line text-muted',
  unsupported: 'bg-line text-muted',
};

function errorText(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : '';
  const [, ...rest] = text.split(' · ');
  return (rest.length ? rest.join(' · ') : text) || fallback;
}

function intervalText(hours: number): string {
  return 24 % hours === 0 && hours < 24 ? `${hours}시간마다 (하루 ${24 / hours}회)` : `${hours}시간마다`;
}

function localTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Status only: no input field. Employees ask in chat; this card says whether that works now. */
function DataConnectionCard({ item }: { item: DataConnectionItem }) {
  return (
    <article className="rounded-2xl border border-line bg-panel p-5 shadow-sm" data-testid={`data-connection-${item.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text">
            데이터 연결: {item.label} · 기준 시각 {item.asOfDisplay ?? '없음'}
          </p>
          {item.description ? <p className="mt-1 text-xs text-muted">{item.description}</p> : null}
        </div>
        <span className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium ${STATUS_BADGE[item.status]}`}>{item.statusLabel}</span>
      </div>
      <p className="mt-3 text-xs text-muted">
        {item.status === 'ready'
          ? '대화에서 물어보면 표와 기준 시각으로 답합니다. 예: 「이 데이터에서 지난주 스타일별 판매량 보여줘」'
          : item.status === 'stale'
            ? `${item.message} 대화에서는 마지막 기준 시각의 데이터로 답합니다.`
            : item.message}
      </p>
    </article>
  );
}

function ExportPanel({
  item,
  servers,
  readOnly,
  busy,
  onWork,
}: {
  item: DataConnectionItem;
  servers: SshServerItem[];
  readOnly: boolean;
  busy: boolean;
  onWork: (work: () => Promise<DataConnectionOverview & { run?: { ok: boolean; message: string } }>, done: string) => Promise<boolean>;
}) {
  const spec = item.export!;
  const registration = spec.registration;
  const [editing, setEditing] = useState(!registration);
  const [serverId, setServerId] = useState(spec.serverId ?? registration?.serverId ?? '');
  const [command, setCommand] = useState('');
  const pinned = spec.serverId ? servers.find((server) => server.id === spec.serverId) : undefined;
  const serverName = (id: string) => servers.find((server) => server.id === id)?.label ?? id;

  useEffect(() => {
    setEditing(!registration);
  }, [registration]);

  const register = async () => {
    const ok = await onWork(() => registerDatasetExport(item.id, serverId, command), `등록됨 · ${item.label} 내보내기`);
    if (ok) {
      setCommand('');
      setEditing(false);
    }
  };

  return (
    <article className="rounded-2xl border border-line bg-panel p-5 shadow-sm" data-testid={`data-export-${item.id}`}>
      <div className="flex items-center gap-2">
        <UploadSimple size={17} className="text-accent" />
        <h4 className="text-sm font-semibold">{item.label} 내보내기</h4>
      </div>
      <p className="mt-1 text-xs text-muted">
        앱이 켜져 있는 동안 {intervalText(spec.intervalHours)} 서버에서 데이터를 받아 팀 공유 폴더에 저장합니다. 개인정보 열은 저장하지 않습니다.
      </p>
      {registration && !editing ? (
        <div className="mt-3 space-y-2 text-xs">
          <p className="text-muted">
            실행 서버 <span className="text-text">{serverName(registration.serverId)}</span>
            {registration.lastSuccessAt ? <> · 마지막 성공 <span className="text-text">{localTime(registration.lastSuccessAt)}</span></> : null}
          </p>
          {registration.lastRun ? (
            <p className={registration.lastRun.ok ? 'text-muted' : 'text-red-300'}>
              {localTime(registration.lastRun.at)} · {registration.lastRun.ok ? '성공' : '실패'} · {registration.lastRun.message}
            </p>
          ) : <p className="text-muted">아직 실행하지 않았습니다.</p>}
          {!registration.commandMatches ? (
            <p className="flex items-center gap-1.5 text-red-300"><Warning size={13} /> 배포된 명령이 바뀌어 실행하지 않습니다. 새로 받은 명령으로 다시 등록하세요.</p>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={readOnly || busy || !registration.commandMatches}
              onClick={() => void onWork(() => runDatasetExport(item.id), `${item.label} 갱신을 마쳤습니다`)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ArrowsClockwise size={13} weight="bold" /> 지금 갱신
            </button>
            <button type="button" disabled={readOnly || busy} onClick={() => setEditing(true)} className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-text disabled:opacity-45">다시 등록</button>
            <button type="button" disabled={readOnly || busy} onClick={() => void onWork(() => removeDatasetExport(item.id), `${item.label} 내보내기 등록을 해제했습니다`)} className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-text disabled:opacity-45">등록 해제</button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="block text-[11px] text-muted">
            실행할 서버
            {spec.serverId ? (
              <span className="mt-1 block rounded-lg border border-line bg-ink/40 px-2.5 py-2 text-xs text-text">
                {pinned ? pinned.label : spec.serverId} {pinned ? '' : '· SSH 서버 목록에 없습니다'}
              </span>
            ) : (
              <select value={serverId} onChange={(event) => setServerId(event.target.value)} disabled={readOnly || busy} className="mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-2 text-xs text-text outline-none focus:border-accent">
                <option value="">서버 고르기</option>
                {servers.map((server) => <option key={server.id} value={server.id}>{server.label}{server.managed ? ' · 조직 배포' : ''}</option>)}
              </select>
            )}
          </label>
          <label className="block text-[11px] text-muted">
            내보내기 명령 (받은 그대로 붙여 넣기)
            <textarea
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              disabled={readOnly || busy}
              rows={4}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-accent"
            />
          </label>
          <p className="text-[11px] text-muted">배포된 명령과 한 글자라도 다르면 등록하지 않습니다. 비밀번호가 들어간 명령도 받지 않습니다.</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={readOnly || busy || !command.trim() || !(spec.serverId || serverId)}
              onClick={() => void register()}
              className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-45"
            >
              등록
            </button>
            {registration ? <button type="button" disabled={busy} onClick={() => setEditing(false)} className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-text">취소</button> : null}
          </div>
        </div>
      )}
    </article>
  );
}

export function SettingsDataConnectionPage({ readOnly, overview, onOverviewChange, onOpenSsh }: SettingsDataConnectionPageProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [servers, setServers] = useState<SshServerItem[]>([]);
  const operatorView = Boolean(overview && (overview.operatorMode || overview.sshServerCount > 0));

  useEffect(() => {
    if (!operatorView) return;
    let cancelled = false;
    void listSshServers().then((next) => { if (!cancelled) setServers(next); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [operatorView]);

  const work = async (
    task: () => Promise<DataConnectionOverview & { run?: { ok: boolean; message: string } }>,
    done: string,
  ): Promise<boolean> => {
    setBusy(true);
    setMessage('');
    try {
      const next = await task();
      onOverviewChange(next);
      setMessage(next.run ? `${next.run.ok ? done : '갱신 실패'} · ${next.run.message}` : done);
      return next.run ? next.run.ok : true;
    } catch (error) {
      setMessage(errorText(error, '처리하지 못했습니다.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const exportable = (overview?.datasets ?? []).filter((item) => item.export);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 flex items-start justify-between gap-4 pr-12">
        <div>
          <h2 className="text-xl font-semibold">데이터 연결</h2>
          <p className="mt-1 text-sm text-muted">조직이 연결한 팀 데이터를 대화에서 바로 물어볼 수 있습니다. 이 화면에서는 연결 상태와 기준 시각만 확인합니다.</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void work(() => getDataConnections(), '상태를 새로 확인했습니다')}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-text disabled:opacity-45"
        >
          <ArrowsClockwise size={13} /> 새로 확인
        </button>
      </header>

      {message ? <p className="mb-5 max-w-3xl rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted" role="status">{message}</p> : null}

      <section className="max-w-3xl space-y-3" aria-label="데이터 연결 상태">
        {overview === null ? <p className="text-sm text-muted">불러오는 중...</p> : null}
        {overview && overview.datasets.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line px-5 py-8 text-center">
            <Database size={22} className="mx-auto text-muted" />
            <p className="mt-2 text-sm text-muted">아직 연결된 데이터가 없습니다. 조직에서 데이터 연결을 배포하면 여기에 표시됩니다.</p>
          </div>
        ) : null}
        {overview?.datasets.map((item) => <DataConnectionCard key={item.id} item={item} />)}
      </section>

      {operatorView ? (
        <section className="mt-8 max-w-3xl space-y-3" aria-label="운영자 데이터 내보내기">
          <div>
            <h3 className="font-semibold">운영자 · 데이터 내보내기</h3>
            <p className="mt-0.5 text-xs text-muted">
              배포된 명령만 이 PC의 SSH 연결로 실행합니다. 서버 연결은{' '}
              <button type="button" onClick={onOpenSsh} className="underline underline-offset-2 hover:text-text">SSH 서버</button>에서 준비하세요.
            </p>
          </div>
          {exportable.length === 0 ? <p className="text-xs text-muted">내보내기가 정의된 데이터가 없습니다.</p> : null}
          {exportable.map((item) => (
            <ExportPanel key={item.id} item={item} servers={servers} readOnly={readOnly} busy={busy} onWork={work} />
          ))}
        </section>
      ) : null}

      {overview ? (
        <details className="mt-10 max-w-3xl text-xs text-muted">
          <summary className="cursor-pointer select-none">고급</summary>
          <label className="mt-3 flex items-start gap-2">
            <input
              type="checkbox"
              checked={overview.operatorMode}
              disabled={readOnly || busy}
              onChange={(event) => void work(() => setDataOperatorMode(event.target.checked), event.target.checked ? '운영자 설정을 표시합니다' : '운영자 설정을 숨겼습니다')}
              className="mt-0.5"
            />
            <span>
              <span className="text-text">운영자 설정 보이기</span>
              <span className="block">SSH 서버와 데이터 내보내기 화면을 설정에 표시합니다. 데이터를 내보내는 운영 담당자만 켜세요. 다른 PC·서버에 접속하거나 이 PC를 서버로 열 때도 켭니다.</span>
              {!overview.operatorMode && overview.sshServerCount > 0 ? (
                <span className="mt-1 block">이 PC에 등록된 SSH 서버가 있어 운영자 설정이 이미 표시되고 있습니다.</span>
              ) : null}
            </span>
          </label>
        </details>
      ) : null}
    </div>
  );
}
