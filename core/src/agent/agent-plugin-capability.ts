/**
 * Capability resolution for local plugins:
 * builtin first → shipped template → freeform scaffold.
 * Closes “NL instruction → pick right tool plane” without ad-hoc guessing.
 */
import {
  resolvePluginTemplateId,
  wantsPluginInstall,
  wantsPluginUse,
  isPluginPlaneRequest,
  defaultArgsForPluginTool,
} from './agent-plugin-intent.js';
import type { AgentToolCall } from './agent-tool-types.js';

export type CapabilityAction =
  | 'use_builtin'
  | 'use_installed_plugin'
  | 'install_template'
  | 'scaffold_freeform'
  | 'none';

export type CapabilityPlan = {
  action: CapabilityAction;
  /** tool name to call or install target tool */
  tool?: string;
  template_id?: string;
  scaffold_id?: string;
  purpose?: string;
  reason: string;
  risk?: 'read' | 'write' | 'network';
};

/** Capability keywords → core builtin tool (prefer over plugin/template). */
const BUILTIN_HINTS: Array<{ tool: string; re: RegExp; reason: string }> = [
  {
    tool: 'git_history_tree',
    re: /git[_\s-]?history|히스토리\s*트리|history\s*tree|커밋\s*(?:그래프|graph)/i,
    reason: 'builtin git_history_tree covers commit graph',
  },
  {
    tool: 'git_status',
    re: /git\s*status|더티|dirty|working\s*tree|변경된\s*파일\s*목록/i,
    reason: 'builtin git_status',
  },
  {
    tool: 'git_log',
    re: /git\s*log|커밋\s*로그|최근\s*커밋/i,
    reason: 'builtin git_log',
  },
  {
    tool: 'git_diff',
    re: /git\s*diff|diff\s*보여|변경\s*diff/i,
    reason: 'builtin git_diff',
  },
  {
    tool: 'read_file',
    re: /(?:파일|file)\s*(?:읽|read)|read_file|내용\s*보여/i,
    reason: 'builtin read_file',
  },
  {
    tool: 'list_directory',
    re: /디렉터리|폴더\s*목록|list_directory|ls\s*해/i,
    reason: 'builtin list_directory',
  },
  {
    tool: 'search_files',
    re: /search_files|파일\s*검색|grep\s*코드/i,
    reason: 'builtin search_files',
  },
];

/**
 * Resolve what the agent should do for a user message regarding tools/plugins.
 * toolNames = current catalog (builtins + enabled plugins).
 */
export function resolveCapabilityPlan(
  message: string,
  toolNames: string[],
): CapabilityPlan {
  const names = new Set(toolNames.map((n) => n.toLowerCase()));
  const msg = String(message || '');

  // 1) Already installed product plugin named in message
  const direct = msg.match(/\b(plugin_[a-z0-9_]{2,56})\b/i);
  const meta = new Set([
    'plugin_list',
    'plugin_install',
    'plugin_scaffold',
    'plugin_set_enabled',
  ]);
  if (direct?.[1] && names.has(direct[1].toLowerCase()) && !meta.has(direct[1].toLowerCase())) {
    return {
      action: 'use_installed_plugin',
      tool: direct[1],
      reason: `installed plugin ${direct[1]} is in catalog`,
    };
  }

  // 2) Builtin when present in catalog (product ships it)
  for (const b of BUILTIN_HINTS) {
    if (!b.re.test(msg)) continue;
    if (names.has(b.tool.toLowerCase())) {
      // User asked to add as local plugin even when builtin exists → still allow template path.
      if (
        wantsPluginInstall(msg)
        && /플러그인|plugin|애드온|로컬\s*에|이\s*PC/i.test(msg)
      ) {
        break;
      }
      return {
        action: 'use_builtin',
        tool: b.tool,
        reason: b.reason,
      };
    }
  }

  // 3) Template install when shipped blueprint matches
  const templateId = resolvePluginTemplateId(msg);
  if (templateId) {
    const pluginName = `plugin_${templateId}`;
    if (names.has(pluginName.toLowerCase())) {
      return {
        action: 'use_installed_plugin',
        tool: pluginName,
        template_id: templateId,
        reason: `plugin already installed (${pluginName})`,
      };
    }
    // If builtin already covers (e.g. git_history_tree) and user did not demand plugin install:
    if (
      templateId === 'git_history_tree'
      && names.has('git_history_tree')
      && !wantsPluginInstall(msg)
      && !/플러그인|plugin|애드온/i.test(msg)
    ) {
      return {
        action: 'use_builtin',
        tool: 'git_history_tree',
        reason: 'prefer builtin git_history_tree over template when available',
      };
    }
    if (wantsPluginInstall(msg) || wantsPluginUse(msg) || isPluginPlaneRequest(msg)) {
      return {
        action: 'install_template',
        template_id: templateId,
        tool: pluginName,
        reason: `shipped template ${templateId}`,
        risk: 'read',
      };
    }
  }

  // 4) Freeform: user wants a new local capability not covered
  if (wantsPluginInstall(msg) || wantsFreeformCapability(msg)) {
    const purpose = extractPurpose(msg);
    const scaffoldId = slugFromPurpose(purpose || msg);
    return {
      action: 'scaffold_freeform',
      scaffold_id: scaffoldId,
      purpose: purpose || msg.slice(0, 200),
      reason: 'no matching builtin/template — scaffold freeform plugin (HITL install)',
      risk: inferRiskFromMessage(msg),
    };
  }

  // 5) Use-only with template id already resolved above; leftover install-like words
  if (templateId && names.has(`plugin_${templateId}`.toLowerCase())) {
    return {
      action: 'use_installed_plugin',
      tool: `plugin_${templateId}`,
      reason: 'use installed template plugin',
    };
  }

  return { action: 'none', reason: 'no plugin/capability signal' };
}

export function wantsFreeformCapability(message: string): boolean {
  const t = String(message || '');
  if (!/(?:도구|툴|플러그인|plugin|기능|애드온|addon)/i.test(t)) return false;
  return /(?:만들|추가|설치|scaffold|새로\s*짜|작성해|구현해)/i.test(t);
}

function extractPurpose(message: string): string {
  const t = String(message || '').trim();
  const m =
    t.match(/(?:목적|purpose|하는\s*일)\s*[:：]\s*(.+)$/i)
    || t.match(/(?:다음|아래)\s*(?:기능|도구)\s*[:：]?\s*(.+)$/i);
  if (m?.[1]) return m[1].trim().slice(0, 400);
  return t.slice(0, 400);
}

function slugFromPurpose(text: string): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (ascii && /^[a-z][a-z0-9_]{1,55}$/.test(ascii)) return ascii;
  // Korean / free text → short hash-like id
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return `custom_${(h % 1_000_000).toString(36)}`;
}

function inferRiskFromMessage(message: string): 'read' | 'write' | 'network' {
  if (/network|http|fetch|api\s*호출|다운로드|upload/i.test(message)) return 'network';
  if (/write|쓰|저장|삭제|delete|수정\s*파일|파일\s*쓰/i.test(message)) return 'write';
  return 'read';
}

/** System note for the capability decision this turn. */
export function formatCapabilityPlanSystemNote(plan: CapabilityPlan): string {
  if (plan.action === 'none') return '';
  const lines = [
    'CAPABILITY PLAN (builtin → template → freeform; do not invent other order):',
    `  action=${plan.action}`,
    plan.tool ? `  tool=${plan.tool}` : '',
    plan.template_id ? `  template_id=${plan.template_id}` : '',
    plan.scaffold_id ? `  scaffold_id=${plan.scaffold_id}` : '',
    plan.purpose ? `  purpose=${plan.purpose.slice(0, 160)}` : '',
    plan.risk ? `  risk=${plan.risk}` : '',
    `  reason: ${plan.reason}`,
  ];
  switch (plan.action) {
    case 'use_builtin':
      lines.push(`  NEXT: call ${plan.tool} (do not plugin_install for this).`);
      break;
    case 'use_installed_plugin':
      lines.push(`  NEXT: call ${plan.tool} with sensible args.`);
      break;
    case 'install_template':
      lines.push(
        `  NEXT: plugin_install template_id=${plan.template_id} confirm=true then call ${plan.tool}.`,
      );
      break;
    case 'scaffold_freeform':
      lines.push(
        '  NEXT: plugin_scaffold → show purpose+risk to user → plugin_install with tool_json+run_source.',
        '  Freeform install requires UI Accept (HITL). Do not claim installed without tool result.',
      );
      break;
    default:
      break;
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * Deterministic first tool from capability plan when the model omits TOOL_CALL.
 */
export function inferToolFromCapabilityPlan(
  plan: CapabilityPlan,
  toolNames: string[],
  message: string,
): AgentToolCall | null {
  const has = (n: string) => toolNames.includes(n);

  if (plan.action === 'use_builtin' && plan.tool && has(plan.tool)) {
    return {
      id: 'cap_use_builtin',
      type: 'function',
      function: {
        name: plan.tool,
        arguments: JSON.stringify(
          plan.tool === 'git_history_tree' ? { max: 15 } : {},
        ),
      },
    };
  }

  if (plan.action === 'use_installed_plugin' && plan.tool && has(plan.tool)) {
    return {
      id: 'cap_use_plugin',
      type: 'function',
      function: {
        name: plan.tool,
        arguments: JSON.stringify(defaultArgsForPluginTool(plan.tool)),
      },
    };
  }

  if (plan.action === 'install_template' && plan.template_id && has('plugin_install')) {
    // If already installed, fall through to use
    if (plan.tool && has(plan.tool)) {
      return {
        id: 'cap_use_plugin',
        type: 'function',
        function: {
          name: plan.tool,
          arguments: JSON.stringify(defaultArgsForPluginTool(plan.tool)),
        },
      };
    }
    return {
      id: 'cap_install_template',
      type: 'function',
      function: {
        name: 'plugin_install',
        arguments: JSON.stringify({
          template_id: plan.template_id,
          confirm: true,
        }),
      },
    };
  }

  if (plan.action === 'scaffold_freeform' && has('plugin_scaffold')) {
    // After scaffold tools used, do not re-scaffold — install is freeform + HITL.
    if (!has('plugin_install')) return null;
    return {
      id: 'cap_scaffold',
      type: 'function',
      function: {
        name: 'plugin_scaffold',
        arguments: JSON.stringify({
          id: plan.scaffold_id || 'custom_tool',
          purpose: plan.purpose || message.slice(0, 200),
          risk: plan.risk || 'read',
        }),
      },
    };
  }

  return null;
}

/**
 * Whether plugin_install args require UI Accept (HITL).
 * Template installs that map to read templates stay confirm-gate only;
 * freeform tool_json installs always need Accept when UI is available.
 */
export function pluginInstallNeedsHitl(args: Record<string, unknown>): {
  needed: boolean;
  danger: boolean;
  summary: string;
} {
  const templateId =
    typeof args.template_id === 'string' ? args.template_id.trim() : '';
  if (templateId) {
    // Known blueprints are low-risk; confirm=true is enough (no UI unless write template later)
    return { needed: false, danger: false, summary: '' };
  }
  // Freeform: tool_json + run_source on this PC
  const id = typeof args.id === 'string' ? args.id : '(id?)';
  const riskRaw =
    args.tool_json && typeof args.tool_json === 'object'
      ? String((args.tool_json as { risk?: string }).risk || 'read')
      : 'read';
  const danger = riskRaw === 'write' || riskRaw === 'network';
  return {
    needed: true,
    danger,
    summary: danger
      ? `로컬 freeform 플러그인 설치 (${id}, risk=${riskRaw}) — Accept 필요`
      : `로컬 freeform 플러그인 설치 (${id}) — Accept 필요`,
  };
}

export { BUILTIN_HINTS };
