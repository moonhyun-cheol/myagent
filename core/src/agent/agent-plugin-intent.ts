/**
 * Local plugin plane intent — template map + install/use detection.
 * Closes “user instruction → install → run” without relying only on free-form LLM tool choice.
 */
import type { AgentToolCall } from './agent-tool-types.js';

/** Keyword → tools/plugin-templates/{id} */
const TEMPLATE_HINTS: Array<{ id: string; re: RegExp }> = [
  {
    id: 'file_stat',
    re: /file_stat|파일\s*stat|파일\s*크기\s*플러그인/i,
  },
  {
    id: 'json_read',
    re: /json_read|json\s*키|package\.json\s*키/i,
  },
];

export function wantsPluginInstall(message: string): boolean {
  const t = String(message || '');
  return (
    /plugin_install|플러그인\s*설치|로컬\s*(?:에\s*)?설치|애드온\s*설치|addon\s*install|template_id\s*=/i.test(
      t,
    )
    || (/(?:기능(?:을)?\s*추가|추가해|깔아|설치해|만들어\s*줘|추가해\s*줘)/i.test(t)
      && /(?:플러그인|plugin|히스토리|애드온|도구|template|graph|트리)/i.test(t))
  );
}

export function wantsPluginUse(message: string): boolean {
  const t = String(message || '');
  return (
    /plugin_git_|plugin_demo_|plugin_workspace_|plugin_env_|plugin_file_|plugin_json_|plugin_vcs_/i.test(
      t,
    )
    || /(?:실행해|호출해|써\s*보|보여줘|그래프로|트리\s*로|결과)\s*(?:봐|보여|줘)?/i.test(t)
    || (
      /(?:사용|실행|호출)\s*(?:해|하)/i.test(t)
      && /(?:플러그인|plugin|히스토리|트리|그래프)/i.test(t)
    )
  );
}

/** Any chat turn that should stay on the code-agent tool plane for plugins. */
export function isPluginPlaneRequest(message: string): boolean {
  const t = String(message || '').trim();
  if (!t) return false;
  if (wantsPluginInstall(t) || wantsPluginUse(t)) return true;
  if (/\bplugin_(?:list|install|scaffold|set_enabled)\b/i.test(t)) return true;
  if (/플러그인|애드온|local\s*plugin|agent-plugins|template_id/i.test(t)) return true;
  if (TEMPLATE_HINTS.some((h) => h.re.test(t))) return true;
  return false;
}

export function resolvePluginTemplateId(message: string): string | null {
  const t = String(message || '');
  const explicit = t.match(/template_id\s*[=:]\s*([a-z0-9_]+)/i);
  if (explicit?.[1]) return explicit[1].toLowerCase();
  const fromPhrase = t.match(
    /(?:템플릿|template)\s*[:：]?\s*([a-z0-9_]+)/i,
  );
  if (fromPhrase?.[1] && isKnownTemplateId(fromPhrase[1])) {
    return fromPhrase[1].toLowerCase();
  }
  for (const h of TEMPLATE_HINTS) {
    if (h.re.test(t)) return h.id;
  }
  return null;
}

function isKnownTemplateId(id: string): boolean {
  return TEMPLATE_HINTS.some((h) => h.id === id.toLowerCase());
}

/**
 * Prefer running the installed tool in the same turn after install
 * (user asked install+use, or install alone for known templates — still demo-run once).
 * Skip when user clearly asked install-only.
 */
export function wantsImmediatePluginUseAfterInstall(message: string): boolean {
  const t = String(message || '');
  if (/(?:설치만|install\s*only|실행\s*하지\s*마|쓰지\s*마|호출\s*하지)/i.test(t)) {
    return false;
  }
  if (wantsPluginUse(message)) return true;
  // “기능 추가해서 보여줘” class
  if (wantsPluginInstall(message) && /(?:보여|확인|사용|실행|그래프|트리|해\s*줘)/i.test(message)) {
    return true;
  }
  // Explicit template installs: always smoke-run once so install≠dead feature
  if (wantsPluginInstall(message) && resolvePluginTemplateId(message)) return true;
  return false;
}

/** Default args when auto-invoking a template plugin. */
export function defaultArgsForPluginTool(toolName: string): Record<string, unknown> {
  if (/history_tree|hist_tree/i.test(toolName)) return { max: 15 };
  if (/workspace_ls/i.test(toolName)) return { path: '.', max: 30 };
  if (/file_stat/i.test(toolName)) return { path: 'README.md' };
  if (/json_read/i.test(toolName)) return { path: 'package.json' };
  if (/demo_echo/i.test(toolName)) return { message: 'plugin-ok' };
  return {};
}

/**
 * Inject first TOOL_CALL when model omitted tools but the user clearly demanded
 * install of a known template (confirm=true — user already ordered install in chat).
 */
export function inferPluginInstallToolCall(
  message: string,
  toolNames: string[],
): AgentToolCall | null {
  if (!toolNames.includes('plugin_install')) return null;
  if (!wantsPluginInstall(message) && !resolvePluginTemplateId(message)) return null;
  // Prefer template when we know it; bare install intent with history keywords maps above
  const templateId =
    resolvePluginTemplateId(message)
    || null;
  if (!templateId) {
    // list first so model/agent sees templates
    if (toolNames.includes('plugin_list') && /목록|list|어떤\s*플러그인/i.test(message)) {
      return {
        id: 'inferred_plugin_list',
        type: 'function',
        function: { name: 'plugin_list', arguments: '{}' },
      };
    }
    return null;
  }
  return {
    id: 'inferred_plugin_install',
    type: 'function',
    function: {
      name: 'plugin_install',
      arguments: JSON.stringify({
        template_id: templateId,
        confirm: true,
      }),
    },
  };
}

/** Prefer invoking already-installed plugin tool from message. */
export function inferPluginUseToolCall(
  message: string,
  toolNames: string[],
): AgentToolCall | null {
  const META = new Set([
    'plugin_list',
    'plugin_install',
    'plugin_scaffold',
    'plugin_set_enabled',
  ]);
  const direct = message.match(/\b(plugin_[a-z0-9_]{2,56})\b/i);
  if (direct?.[1] && toolNames.includes(direct[1]) && !META.has(direct[1].toLowerCase())) {
    return {
      id: 'inferred_plugin_use',
      type: 'function',
      function: {
        name: direct[1],
        arguments: JSON.stringify(defaultArgsForPluginTool(direct[1])),
      },
    };
  }
  const tid = resolvePluginTemplateId(message);
  if (tid) {
    const name = `plugin_${tid}`;
    if (toolNames.includes(name) && (wantsPluginUse(message) || !wantsPluginInstall(message))) {
      return {
        id: 'inferred_plugin_use',
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(defaultArgsForPluginTool(name)),
        },
      };
    }
  }
  return null;
}

export function formatPluginTemplatesSystemNote(
  templates: Array<{ id: string; name: string; description?: string; risk?: string }>,
): string {
  if (!templates.length) {
    return 'LOCAL PLUGINS: no tools/plugin-templates found on this install.';
  }
  const lines = templates.map(
    (t) =>
      `  - template_id=${t.id} → ${t.name} (risk=${t.risk ?? 'read'})${
        t.description ? `: ${String(t.description).slice(0, 80)}` : ''
      }`,
  );
  return [
    'LOCAL PLUGIN TEMPLATES (install with plugin_install confirm=true template_id=…):',
    ...lines,
    'After install, call the tool name immediately (same turn). Do not only narrate.',
  ].join('\n');
}

export { TEMPLATE_HINTS };
