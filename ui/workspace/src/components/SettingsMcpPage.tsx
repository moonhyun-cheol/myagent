import { CheckCircle, Plus, Plugs, Trash, Wrench } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import {
  listUserMcpServers,
  saveUserMcpServers,
  testUserMcpServer,
  type UserMcpServerItem,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';

interface SettingsMcpPageProps {
  readOnly: boolean;
}

type ServerDraft = {
  id: string;
  url: string;
  authToken: string;
};

const EMPTY_DRAFT: ServerDraft = { id: '', url: '', authToken: '' };

export function SettingsMcpPage({ readOnly }: SettingsMcpPageProps) {
  const [servers, setServers] = useState<UserMcpServerItem[]>([]);
  const [draft, setDraft] = useState<ServerDraft>(EMPTY_DRAFT);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [activeSection, setActiveSection] = useState<'installed' | 'add'>('installed');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await listUserMcpServers();
      setServers(result.servers);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'MCP 설정을 불러오지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedId && servers.some((server) => server.id === selectedId)) return;
    setSelectedId(servers[0]?.id ?? null);
  }, [servers, selectedId]);

  const saveServers = async (next: UserMcpServerItem[], successMessage: string) => {
    setBusy(true);
    setMessage('');
    try {
      await saveUserMcpServers(next);
      setServers(next);
      setMessage(successMessage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'MCP 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  const updateServer = (index: number, patch: Partial<UserMcpServerItem>) => {
    if (patch.id && servers[index]?.id === selectedId) setSelectedId(patch.id);
    setServers((current) => current.map((server, currentIndex) => (
      currentIndex === index ? { ...server, ...patch } : server
    )));
  };

  const saveServer = async (server: UserMcpServerItem) => {
    if (!server.id.trim() || !server.url.trim()) {
      setMessage('MCP ID와 MCP URL을 입력하세요.');
      return;
    }
    try {
      new URL(server.url);
    } catch {
      setMessage('MCP URL 형식이 올바르지 않습니다.');
      return;
    }
    await saveServers(servers, `저장됨 · ${server.id}`);
  };

  const toggleServer = async (server: UserMcpServerItem) => {
    const next = servers.map((current) => current.id === server.id
      ? { ...current, enabled: current.enabled === false }
      : current);
    await saveServers(next, `${server.id} ${server.enabled === false ? '활성화' : '비활성화'}됨`);
  };

  const removeServer = async (server: UserMcpServerItem) => {
    const ok = await confirmDialog({
      title: '원격 MCP 삭제',
      message: `${server.id}을(를) MCP 목록에서 삭제할까요?`,
      confirmLabel: '삭제',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    await saveServers(servers.filter((current) => current.id !== server.id), `삭제됨 · ${server.id}`);
  };

  const testServer = async (server: UserMcpServerItem) => {
    setTestingId(server.id);
    setTestResults((current) => ({ ...current, [server.id]: '테스트 중...' }));
    try {
      const result = await testUserMcpServer(server.id);
      setTestResults((current) => ({
        ...current,
        [server.id]: result.ok
          ? `연결됨 · capability tool ${result.tool_count ?? 0}개`
          : `실패 · ${result.error || '응답 없음'}`,
      }));
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [server.id]: error instanceof Error ? error.message : '테스트 실패',
      }));
    } finally {
      setTestingId(null);
    }
  };

  const addRemoteServer = async () => {
    const id = draft.id.trim();
    const url = draft.url.trim();
    if (!id || !url) {
      setMessage('MCP ID와 MCP URL을 입력하세요.');
      return;
    }
    try {
      new URL(url);
    } catch {
      setMessage('MCP URL 형식이 올바르지 않습니다.');
      return;
    }
    if (servers.some((server) => server.id === id)) {
      setMessage(`이미 존재하는 MCP ID입니다: ${id}`);
      return;
    }
    const next: UserMcpServerItem[] = [
      ...servers,
      {
        id,
        url,
        authToken: draft.authToken.trim() || undefined,
        authConfigured: Boolean(draft.authToken.trim()),
        enabled: true,
      },
    ];
    await saveServers(next, `추가됨 · ${id}`);
    setDraft(EMPTY_DRAFT);
    setSelectedId(id);
    setActiveSection('installed');
  };

  const selectedIndex = selectedId ? servers.findIndex((server) => server.id === selectedId) : -1;
  const selectedServer = selectedIndex >= 0 ? servers[selectedIndex] : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">MCP</h2>
        <p className="mt-1 text-sm text-muted">원격 Streamable HTTP MCP 서버를 등록하고 capability 연결 상태를 관리합니다.</p>
      </header>

      {message ? <p className="mb-5 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">{message}</p> : null}

      <div className="mb-5 flex max-w-3xl gap-1 rounded-xl border border-line bg-panel p-1" role="tablist" aria-label="MCP 관리 범주">
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === 'installed'}
          onClick={() => setActiveSection('installed')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${activeSection === 'installed' ? 'bg-ink text-text shadow-sm' : 'text-muted hover:text-text'}`}
        >
          등록된 MCP <span className="ml-1 text-xs text-muted">{servers.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === 'add'}
          onClick={() => setActiveSection('add')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${activeSection === 'add' ? 'bg-ink text-text shadow-sm' : 'text-muted hover:text-text'}`}
        >
          원격 MCP 추가
        </button>
      </div>

      {activeSection === 'installed' ? <section className="max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Plugs size={21} className="text-accent" />
          <div>
            <h3 className="font-semibold">등록된 원격 MCP</h3>
            <p className="mt-0.5 text-xs text-muted">MCP 주소와 인증만 관리합니다. API 사용자 인증정보는 이 앱에 저장하지 않습니다.</p>
          </div>
        </div>
        {busy && servers.length === 0 ? <p className="py-4 text-sm text-muted">불러오는 중...</p> : null}
        {!busy && servers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
            <p className="text-sm text-muted">등록된 원격 MCP 서버가 없습니다.</p>
            <button type="button" onClick={() => setActiveSection('add')} className="mt-3 rounded-lg bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/25">원격 MCP 추가</button>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-1 rounded-xl border border-line bg-ink/35 p-2">
              {servers.map((server) => (
                <button
                  key={server.id}
                  type="button"
                  onClick={() => setSelectedId(server.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left ${selectedId === server.id ? 'bg-panel text-text shadow-sm' : 'text-muted hover:bg-panel/70 hover:text-text'}`}
                >
                  <span className="min-w-0 truncate text-xs font-medium">{server.id}</span>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${server.enabled === false ? 'bg-muted/40' : 'bg-accent'}`} title={server.enabled === false ? '꺼짐' : '활성'} />
                </button>
              ))}
            </div>

            {selectedServer ? (
              <div className="rounded-xl border border-line bg-ink/25 p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-medium text-text">{selectedServer.id}</p>
                    {selectedServer.enabled !== false ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent/15 px-2 py-1 text-[10px] text-accent"><CheckCircle size={12} weight="fill" /> 활성</span>
                    ) : <span className="rounded-md bg-line px-2 py-1 text-[10px] text-muted">꺼짐</span>}
                  </div>
                  <button type="button" disabled={readOnly || busy} onClick={() => void toggleServer(selectedServer)} className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45">
                    {selectedServer.enabled === false ? '켜기' : '끄기'}
                  </button>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="text-[11px] text-muted">
                    ID
                    <input value={selectedServer.id} onChange={(event) => updateServer(selectedIndex, { id: event.target.value })} disabled={readOnly || busy} className="mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-accent disabled:opacity-60" />
                  </label>
                  <label className="text-[11px] text-muted">
                    MCP URL
                    <input value={selectedServer.url} onChange={(event) => updateServer(selectedIndex, { url: event.target.value })} disabled={readOnly || busy} placeholder="https://automaton.example/mcp" className="mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-accent disabled:opacity-60" />
                  </label>
                  <label className="text-[11px] text-muted md:col-span-2">
                    MCP 인증 토큰
                    <input type="password" value={selectedServer.authToken ?? ''} onChange={(event) => updateServer(selectedIndex, { authToken: event.target.value || undefined, authConfigured: Boolean(event.target.value) })} disabled={readOnly || busy} placeholder={selectedServer.authConfigured ? '저장된 토큰 유지 · 변경할 때만 입력' : 'Bearer 토큰'} className="mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-accent disabled:opacity-60" />
                  </label>
                </div>
                {testResults[selectedServer.id] ? <p className="mt-2 text-xs text-muted">{testResults[selectedServer.id]}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" disabled={testingId === selectedServer.id || busy} onClick={() => void testServer(selectedServer)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:border-accent/50 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45">
                    <Wrench size={13} />
                    {testingId === selectedServer.id ? '테스트 중...' : '연결 테스트'}
                  </button>
                  <button type="button" disabled={readOnly || busy} onClick={() => void saveServer(selectedServer)} className="rounded-lg bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-45">저장</button>
                  <button type="button" disabled={readOnly || busy} onClick={() => void removeServer(selectedServer)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:border-red-400/50 enabled:hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-45">
                    <Trash size={13} /> 삭제
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section> : null}

      {activeSection === 'add' ? <section className="max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Plus size={19} className="text-accent" />
          <div>
            <h3 className="font-semibold">원격 MCP 추가</h3>
            <p className="mt-0.5 text-xs text-muted">원격 서버가 제공하는 MCP endpoint와 MCP 인증 토큰만 입력합니다.</p>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <label className="text-[11px] text-muted">
            ID
            <input value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} disabled={readOnly || busy} placeholder="automaton" className="mt-1 w-full rounded-lg border border-line bg-ink/60 px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-accent disabled:opacity-60" />
          </label>
          <label className="text-[11px] text-muted">
            MCP URL
            <input value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} disabled={readOnly || busy} placeholder="https://automaton.example/mcp" className="mt-1 w-full rounded-lg border border-line bg-ink/60 px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-accent disabled:opacity-60" />
          </label>
          <label className="text-[11px] text-muted md:col-span-2">
            MCP 인증 토큰
            <input type="password" value={draft.authToken} onChange={(event) => setDraft((current) => ({ ...current, authToken: event.target.value }))} disabled={readOnly || busy} placeholder="Bearer 토큰" className="mt-1 w-full rounded-lg border border-line bg-ink/60 px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-accent disabled:opacity-60" />
          </label>
        </div>
        <button type="button" disabled={readOnly || busy} onClick={() => void addRemoteServer()} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-45">
          <Plus size={14} weight="bold" />
          원격 MCP 등록
        </button>
      </section> : null}
    </div>
  );
}
