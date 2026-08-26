import { Package, Plus, Trash } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  installAgentPluginFromTemplate,
  listAgentPlugins,
  purgeLabSmokePlugins,
  setAgentPluginEnabled,
  uninstallAgentPlugin,
  type AgentPluginListItem,
  type AgentPluginTemplateItem,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';

interface SettingsPluginsPageProps {
  readOnly: boolean;
}

export function SettingsPluginsPage({ readOnly }: SettingsPluginsPageProps) {
  const [agentPlugins, setAgentPlugins] = useState<AgentPluginListItem[]>([]);
  const [pluginTemplates, setPluginTemplates] = useState<AgentPluginTemplateItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const doc = await listAgentPlugins();
      setAgentPlugins(doc.plugins);
      setPluginTemplates(doc.templates);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '플러그인 목록 실패');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installTemplate = async (template: AgentPluginTemplateItem) => {
    const ok = await confirmDialog({
      title: '로컬 플러그인 설치',
      message: `이 PC에 「${template.name}」 플러그인을 설치합니다 (risk=${template.risk}).`,
      confirmLabel: '설치',
      cancelLabel: '취소',
      danger: template.risk === 'write' || template.risk === 'network',
    });
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await installAgentPluginFromTemplate({ template_id: template.id, confirm: true });
      setMessage(result.ok ? `설치됨 · ${result.name || template.name}` : result.error || '설치 실패');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '설치 실패');
    } finally {
      setBusy(false);
    }
  };

  const togglePluginEnabled = async (plugin: AgentPluginListItem) => {
    const next = !plugin.enabled;
    const ok = await confirmDialog({
      title: next ? '플러그인 켜기' : '플러그인 끄기',
      message: `${plugin.name}을(를) ${next ? '사용' : '비활성'}할까요?`,
      confirmLabel: next ? '켜기' : '끄기',
      cancelLabel: '취소',
    });
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      await setAgentPluginEnabled(plugin.id, { enabled: next, confirm: true });
      setMessage(next ? `켜짐 · ${plugin.name}` : `꺼짐 · ${plugin.name}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '플러그인 상태 변경 실패');
    } finally {
      setBusy(false);
    }
  };

  const removePlugin = async (plugin: AgentPluginListItem) => {
    const ok = await confirmDialog({
      title: '플러그인 삭제',
      message: `${plugin.name}을(를) 이 PC에서 삭제할까요?`,
      confirmLabel: '삭제',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      await uninstallAgentPlugin(plugin.id, { confirm: true });
      setMessage(`삭제됨 · ${plugin.name}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '플러그인 삭제 실패');
    } finally {
      setBusy(false);
    }
  };

  const purgeLabSmoke = async () => {
    const ok = await confirmDialog({
      title: '랩 스모크 정리',
      message: '검증용으로 쌓인 스모크 플러그인을 모두 삭제합니다. 사용자 플러그인은 유지됩니다.',
      confirmLabel: '정리',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await purgeLabSmokePlugins();
      setMessage(`정리됨 · ${result.count ?? result.removed?.length ?? 0}개`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '스모크 정리 실패');
    } finally {
      setBusy(false);
    }
  };

  const productPlugins = useMemo(() => agentPlugins.filter((plugin) => !plugin.lab_smoke), [agentPlugins]);
  const labSmokePlugins = useMemo(() => agentPlugins.filter((plugin) => plugin.lab_smoke), [agentPlugins]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">플러그인</h2>
        <p className="mt-1 text-sm text-muted">에이전트가 사용할 로컬 실행 도구를 설치하고 관리합니다.</p>
      </header>

      {message ? <p className="mb-5 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">{message}</p> : null}

      <section className="max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Package size={21} className="text-accent" />
            <h3 className="font-semibold">설치됨</h3>
          </div>
          {labSmokePlugins.length > 0 ? (
            <button
              type="button"
              disabled={readOnly || busy}
              onClick={() => void purgeLabSmoke()}
              className="text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-45"
            >
              랩 스모크 {labSmokePlugins.length}개 정리
            </button>
          ) : null}
        </div>

        {busy && productPlugins.length === 0 ? <p className="py-4 text-sm text-muted">불러오는 중...</p> : null}
        {!busy && productPlugins.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
            설치된 플러그인이 없습니다.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {productPlugins.map((plugin) => (
              <div key={plugin.id} className="rounded-xl border border-line bg-ink/40 p-3">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">{plugin.name}</p>
                    <p className="truncate text-[11px] text-muted">
                      {plugin.id} · risk={plugin.risk}{plugin.runner ? ` · ${plugin.runner}` : ''}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-md px-2 py-1 text-[10px] ${plugin.enabled ? 'bg-accent/15 text-accent' : 'bg-line text-muted'}`}>
                    {plugin.enabled ? '활성' : '꺼짐'}
                  </span>
                </div>
                {plugin.description ? <p className="mb-3 line-clamp-2 text-xs leading-5 text-muted">{plugin.description}</p> : null}
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => void togglePluginEnabled(plugin)}
                    className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:border-accent/50 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {plugin.enabled ? '끄기' : '켜기'}
                  </button>
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => void removePlugin(plugin)}
                    className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:border-red-400/50 enabled:hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Trash size={13} />
                    삭제
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {labSmokePlugins.length > 0 ? (
          <details className="mt-4 rounded-xl border border-dashed border-line/80 bg-ink/30 p-3">
            <summary className="cursor-pointer text-xs text-muted">랩/스모크 잔여 {labSmokePlugins.length}개</summary>
            <div className="mt-2 space-y-1.5">
              {labSmokePlugins.map((plugin) => (
                <div key={plugin.id} className="flex items-center justify-between gap-3 rounded-lg border border-line/60 px-3 py-2">
                  <p className="min-w-0 truncate font-mono text-[11px] text-muted">{plugin.id}</p>
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => void removePlugin(plugin)}
                    className="shrink-0 text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    삭제
                  </button>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <section className="mt-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Plus size={19} className="text-accent" />
          <h3 className="font-semibold">추가 템플릿</h3>
        </div>
        {pluginTemplates.length === 0 ? (
          <p className="text-sm text-muted">표시할 추가 템플릿이 없습니다.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {pluginTemplates.map((template) => {
              if (productPlugins.some((plugin) => plugin.id === template.id)) return null;
              return (
                <div key={template.id} className="rounded-xl border border-line bg-ink/40 p-3">
                  <p className="truncate text-sm font-medium text-text">{template.name}</p>
                  <p className="mt-1 text-[11px] text-muted">{template.id} · risk={template.risk}</p>
                  {template.description ? <p className="mt-2 text-xs leading-5 text-muted">{template.description}</p> : null}
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => void installTemplate(template)}
                    className="mt-3 rounded-lg bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    이 PC에 설치
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
