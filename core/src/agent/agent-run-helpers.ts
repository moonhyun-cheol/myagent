import path from 'node:path';
import type { ChatMessage } from '../providers/openai-compatible.js';
import { chatContentToText } from '../providers/openai-compatible.js';
import type { AgentToolCall } from './tools.js';
import {
  CHAT_PANE_PATH,
  SHELL_WINDOW_PATH,
  UI_TARGET_MAP_PATH,
  chatUiPathHints,
} from './agent-ui-bootstrap.js';
import type { UiFacts } from './agent-grounding.js';
import { formatUiFactsForPrompt } from './agent-grounding.js';
import {
  buildCodeAgentUserContent,
  formatMultimodalSystemNote,
} from './agent-multimodal.js';
import { enrichWorkspaceIndexContext } from './index/public.js';
import { buildDevWorkspaceContext } from './dev-workspace-fs.js';
import { extractUncOrDrivePaths } from './path-hints.js';
import {
  formatPatchFormatConstraints,
} from './agent-planner.js';
import { sanitizeHistoryForModel, looksLikeTruncatedAssistantReply } from '../chat/chat-filters.js';
import { applyHistoryContentBudget } from '../chat/history-budget.js';
import { buildSessionHistoryBudgetOpts, rememberMessagePins } from '../chat/session-history-budget.js';
import { loadAgentRunMeta } from './agent-run-meta.js';
import { loadHarnessPolicy } from '../providers/harness-policy.js';
import { resolveContextBudgets } from '../providers/model-context-limits.js';
import type { CodeAgentOptions } from './agent-run-types.js';

const CODE_SNIPPET_MAX = 1200;

/** Live P88 dumped CURRENT_STATUS because secretary still got the coding GIT/plugin tax. */
export const SECRETARY_OPS_SPINE = [
  'SECRETARY spine: ≤8 Korean lines. Answer the ops/HITL/status question only.',
  'Tools: list_directory / read_file / run_terminal only if needed. Accept = user tap. Never ask to paste.',
  'FORBIDDEN: CURRENT_STATUS novel, ui-target-map, MainWindow.xaml, ChatPane, GeminiNavSidebar.',
].join('\n');

export function codingTaxSystemLines(): string[] {
  return [
    'Mutate rules: read_file (or list_directory for new files) before write/edit/delete/apply_patch — auto-heal may read for you. Prefer edit_file (one) / apply_patch (multi). No chat-only full-file paste. The built-in agent owns IDE mutations so Responses continuity, approvals, cache invalidation, and verification remain in one runtime.',
    'HITL Accept: delete_file, run_terminal, workspace_rollback, freeform plugin_install (no template_id), plugin_set_enabled (and oversized write/patch). Workspace git_* for the bound repo — but public remote inspect (github.com URL + 설명/구조) → run_terminal `git clone --depth 1 <url> .my_agent_remote/<owner>__<repo>` then list/read. Full history asks → `remote_git_inspect` (ensure_full) — never ask for git bundle upload. Never force-push.',
    'GIT (enterprise/Cursor parity):',
    '- History/branch tree: use builtin git_history_tree (do not install plugin template git_history_tree).',
    '- Compare/sync/pull-diff: call git_sync_preview first (fetch+incoming/outgoing/local dirty). Then detail with git_diff/git_show as needed.',
    '- Apply remote: git_pull confirm=true only after preview and if user wants apply.',
    '- Publish: git_push confirm=true only when user explicitly asks (never invent push).',
    '- Commit: git_status/git_diff → git_commit confirm=true (or git_stage then commit).',
    '- Switch: git_switch confirm=true; dirty tree → git_stash push or commit first.',
    '- Blame/show/branch list are read-only; branch create/restore worktree need confirm.',
    'LOCAL PLUGINS (capability plan — fixed order):',
    '- 1) Prefer matching **builtin** tools already in the catalog.',
    '- 2) Else install shipped **template** via plugin_install template_id=… confirm=true (no freeform).',
    '- 3) Else **plugin_scaffold** (purpose-aware) → show purpose+risk → freeform plugin_install (UI Accept required) → call plugin_*.',
    '- After plugin_install success the runtime auto-invokes the new plugin when the user asked to install/use; narrating "이제 호출합니다" alone is blocked.',
    '- Do not shadow builtins (read_file, git_*). Plugin tool names must start with plugin_. write/network risk tools need confirm=true on invoke.',
  ];
}

export function extractToolCodeSnippet(call: AgentToolCall): { label: string; text: string } | null {
  try {
    const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    const name = call.function.name;
    if (name === 'read_file' && typeof args.path === 'string') {
      return { label: `read ${args.path}`, text: '' };
    }
    if (name === 'write_file' && typeof args.path === 'string' && typeof args.content === 'string') {
      return { label: `write ${args.path}`, text: args.content };
    }
    if (name === 'edit_file' && typeof args.path === 'string' && typeof args.new_text === 'string') {
      return { label: `edit ${args.path}`, text: args.new_text };
    }
    return null;
  } catch {
    return null;
  }
}

export function trimSnippet(text: string): string {
  const t = text.trim();
  if (t.length <= CODE_SNIPPET_MAX) return t;
  return `${t.slice(0, CODE_SNIPPET_MAX)}\n…`;
}


export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function workspaceSnapshot(
  workspaceRoot: string,
  fullContext?: string,
  focusMessage?: string,
  cqrRoot?: string,
): string {
  const focus = focusMessage?.trim() ?? '';
  try {
    return enrichWorkspaceIndexContext(
      workspaceRoot,
      fullContext,
      focus,
      {
        repoMapMaxChars: 6_000,
        queryMaxChars: 3_500,
        cqrRoot,
      },
    ) || buildDevWorkspaceContext(workspaceRoot, {}, {
      tier: 'agent',
      focusMessage: focus || undefined,
      includeRepoMap: true,
    });
  } catch {
    return fullContext?.trim() || '(workspace listing failed)';
  }
}

export function buildAgentMessages(
  opts: CodeAgentOptions,
  guard: { allowNas?: boolean },
  toolNames: string[],
  useClientToolProtocol = false,
  uiFacts: UiFacts | null = null,
  productMemoryBlock = '',
  selfWorkspace = false,
  /** When false, skip UI map / Live UI facts / AGENTS.md dump (secretary ops). */
  injectUiMap = selfWorkspace,
): ChatMessage[] {
  rememberMessagePins(opts.cqrRoot, opts.sessionId, opts.userMessage);
  const root = toPosix(path.resolve(opts.workspaceRoot));
  const hasImages = (opts.imageDataUrls?.length ?? 0) > 0;
  const hasAttach = Boolean(opts.attachmentContext?.trim());
  const protocolLines = useClientToolProtocol
    ? [
        'Tools run in-process via TOOL_CALL: lines (see protocol note). Ollama/passthrough-off OWUI must use TOOL_CALL.',
      ]
    : [
        'Tools run in-process via native API tool_calls. Prefer read→edit_file/apply_patch→run_diagnostics/run_tests; git_commit/git_pull/git_push/git_switch/git_restore need confirm=true where required.',
      ];
  const selfUiLines = selfWorkspace
    ? injectUiMap
      ? [
          'Product UI = ui/workspace at /. Classify UI target (shell titlebar / native confirm / ChatPane) — never default every UI edit to ChatPane.',
          'GROUNDING: no Title=/WindowStyle=/confirm() claims without read_file this run. Prefer Live UI facts.',
          'DONE: mutated paths must include the UI target; 완료 = user Acceptance path (not tsc alone). 「연결/인앱」 needs postMessage inAppBrowser.open or NavigationStarting→OpenInAppBrowser (`<a href>` alone = PARTIAL).',
          'Ambiguous UI target + no screenshot → one short clarify before edit.',
        ]
      : [
          'Self-workspace secretary/ops — answer the question only.',
          'FORBIDDEN: dump ui-target-map / MainWindow.xaml / ChatPane / GeminiNavSidebar unless the user asked to edit those UI targets.',
          'GROUNDING: no file-content claims without read_file this run.',
        ]
    : [
        'External project workspace — do NOT cite MY Agent paths (ui/workspace, ChatPane, MainWindow.xaml).',
        'GROUNDING: no file-content claims without read_file this run. Discover via map/search/read (UNC/absolute OK when user points outside).',
      ];
  const memoryForPrompt = injectUiMap
    ? productMemoryBlock
    : String(productMemoryBlock || '').replace(
        /### AGENTS\.md[\s\S]*$/,
        'SECRETARY: do not dump ui-target-map / MainWindow / ChatPane unless the user asked to edit UI.\n',
      );
  const codingSpine = opts.agentPromptProfile !== 'general';
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        opts.systemPrompt?.trim() ?? '',
        '',
        'You are one workspace agent. Decide from the conversation whether to explain, inspect, plan, mutate, or call tools.',
        'The local runtime does not classify the request or choose tools for you. Use any available safe tool when it improves the result; do not call tools merely to satisfy a local workflow.',
        codingSpine
          ? 'When accepted work cannot finish this turn, call active_task set/block before answering. On later turns reconcile that task with the latest request; never silently drop it. After mutation and an explicit outcome-relevant Acceptance tool, call active_task complete. Automatic diagnostics alone never complete it. User correction may replace/cancel it.'
          : 'Answer in the form best suited to the request. Do not force a completion-report, review table, or paths footer. Call tools only when they improve the answer.',
        'Tools always run in-process — never role-play "cannot edit" / Tool not found / missing tool server / Manager Restart fiction.',
        'NEVER invent: no terminal, no internet, cannot clone public GitHub, "run this locally and paste output", or "upload a git bundle". Public clones use run_terminal (HITL Accept may prompt). After clone evidence, never retract to 「미검증」.',
        `Dev workspace root (not an FS cage): ${root}`,
        'Relative paths resolve here; absolute/UNC allowed when the user points outside. NAS writes need consent. Do not ask to copy NAS files in — list/read UNC directly.',
        `Available tools: ${toolNames.join(', ')}.`,
        ...protocolLines,
        ...selfUiLines,
        'Preserve useful findings and answer in the form best suited to the user request.',
        codingSpine
          ? formatPatchFormatConstraints()
          : 'If you edit files, mutate via tools only (read before write). Prefer apply_patch / edit_file. Do not paste full files in chat.',
        injectUiMap ? formatUiFactsForPrompt(uiFacts) : '',
        memoryForPrompt,
        injectUiMap ? chatUiPathHints(opts.userMessage, selfWorkspace) : '',
        formatMultimodalSystemNote(hasImages, hasAttach, false),
        '',
        useClientToolProtocol
          ? 'Protocol: TOOL_CALL JSON first line (see TOOL_CALL protocol note). No XML/<invoke>.'
          : '',
        'Workspace files (discovery context only; read concrete files before file-content claims):',
        workspaceSnapshot(opts.workspaceRoot, opts.workspaceContext, opts.userMessage, opts.cqrRoot),
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  for (const m of applyHistoryContentBudget(
    sanitizeHistoryForModel(opts.history ?? []),
    process.env,
    buildSessionHistoryBudgetOpts({
      cqrRoot: opts.cqrRoot,
      sessionId: opts.sessionId,
      modelId: opts.modelId,
      extraPins: (loadAgentRunMeta(opts.cqrRoot, opts.sessionId).mutatedPaths ?? [])
        .slice(0, 8)
        .map((p) => `mutated:${p}`),
      debit: {
        visionImageCount: Array.isArray(opts.imageDataUrls) ? opts.imageDataUrls.length : 0,
        attachmentChars: opts.attachmentContext ? String(opts.attachmentContext).length : 0,
      },
    }),
  )) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  }
  messages.push({
    role: 'user',
    content: buildCodeAgentUserContent(
      opts.userMessage,
      opts.attachmentContext,
      opts.imageDataUrls,
    ),
  });
  return messages;
}

export function lastSuccessfulReadPath(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    for (const call of m.tool_calls) {
      if (call.function?.name !== 'read_file') continue;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as { path?: string };
        if (typeof args.path === 'string' && args.path.trim()) return args.path.trim();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function messagesHadToolRole(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'tool');
}

export function looksLikeFileEditTask(message: string): boolean {
  // Bare "코드" appears in 「코드 수정 금지」 — do not treat as edit task alone.
  return /(?:\.py|\.js|\.ts|\.tsx|\.jsx|\.html|\.css|\.md\b|파일|file|교체|replace|write|edit_file|apply_patch|작성|채팅창|ChatPane|Composer|입력창|높이|키워|늘려|줄여|레이아웃|사이드바|컴포저|composer|늘리|줄이|ui\/web|작업\s*폴더|우클릭|컨텍스트\s*메뉴|context\s*menu|캔버스|미리보기)|(?:코드\s*(?:수정|편집|고쳐|변경|파일|작성|추가)|수정(?!\s*(?:금지|없이|말고|하지\s*마|은\s*하지)))/i.test(
    message,
  );
}


export function isOwuiOrGatewayError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  return (
    raw.includes('OWUI_GATEWAY_TIMEOUT') ||
    raw.includes('UPSTREAM_HTML_ERROR') ||
    /HTTP 50[234]/.test(raw) ||
    lower.includes('fetch failed') ||
    lower.includes('timeout') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound')
  );
}

export type TruncateToolResultOpts = {
  modelId?: string | null;
  maxChars?: number;
};

/** Request-scoped tool budget (set for the duration of runAgentStepLoop). */
let activeToolBudget: TruncateToolResultOpts | null = null;

export async function runWithToolBudget<T>(
  opts: TruncateToolResultOpts,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = activeToolBudget;
  activeToolBudget = opts;
  try {
    return await fn();
  } finally {
    activeToolBudget = prev;
  }
}

function resolveToolMaxChars(opts?: TruncateToolResultOpts): number {
  const merged: TruncateToolResultOpts = { ...activeToolBudget, ...opts };
  if (typeof merged.maxChars === 'number' && merged.maxChars > 0) return merged.maxChars;
  if (merged.modelId) return resolveContextBudgets(merged.modelId).toolResultMaxChars;
  return loadHarnessPolicy().toolResultMaxChars;
}

function headTailTruncate(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = Math.max(0, max - head - 80);
  return `${text.slice(0, head)}\n\n… (${label}: ${text.length.toLocaleString()} → ${max.toLocaleString()} chars)\n\n${text.slice(-tail)}`;
}

function compressJsonToolResult(raw: string, max: number): string | null {
  try {
    const doc = JSON.parse(raw) as unknown;
    if (!doc || typeof doc !== 'object') return null;
    const preferKeys = [
      'ok',
      'error',
      'message',
      'path',
      'file',
      'paths',
      'mutated',
      'status',
      'exitCode',
      'stdout',
      'stderr',
      'query',
      'count',
      'hits',
      'total',
    ];
    const obj = doc as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of preferKeys) {
      if (k in obj) out[k] = obj[k];
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k in out) continue;
      if (typeof v === 'string' && v.length > 800) {
        out[k] = `${v.slice(0, 600)}…(+${v.length - 600})`;
      } else {
        out[k] = v;
      }
    }
    let s = JSON.stringify(out, null, 0);
    if (s.length > max) s = headTailTruncate(s, max, 'tool json truncated');
    return s;
  } catch {
    return null;
  }
}

function looksLikeLogOrDiff(raw: string): boolean {
  if (/^diff --git /m.test(raw) || /^\+\+\+ |\-\-\- /m.test(raw)) return true;
  if (raw.length > 2_000 && (raw.match(/\n/g)?.length ?? 0) > 40) {
    if (/^\d{4}-\d{2}-\d{2}|^\[?\d{1,2}:\d{2}|ERROR|WARN|INFO|DEBUG/m.test(raw)) return true;
  }
  return false;
}

/**
 * Cap tool results fed back into the next LLM request.
 * Content-aware: inspect dumps → path+excerpt; JSON → prefer keys; logs → head/tail.
 */
export function truncateToolResultForLlm(
  output: string,
  toolName?: string,
  opts?: TruncateToolResultOpts,
): string {
  const max = resolveToolMaxChars(opts);
  const name = toolName ? ` (${toolName})` : '';
  const raw = String(output ?? '');
  if (!raw) return raw;

  if (raw.length <= max) return raw;

  if (raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) {
    const json = compressJsonToolResult(raw, max);
    if (json) return json;
  }

  if (looksLikeLogOrDiff(raw)) {
    return headTailTruncate(raw, max, `tool log/diff truncated${name}`);
  }

  return headTailTruncate(raw, max, `tool result truncated${name}`);
}

export function estimateChatPayloadChars(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += chatContentToText(m.content).length;
    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        n += (tc.function?.name?.length ?? 0) + (tc.function?.arguments?.length ?? 0);
      }
    }
  }
  return n;
}

/**
 * In-place shrink after OWUI 504 — keep recent tool turns, stub older bulky tool bodies.
 * Returns bytes removed (approx). Used before a same-step infra retry.
 */
export function shrinkMessagesForInfraRetry(
  messages: ChatMessage[],
  opts?: { keepRecentToolTurns?: number; maxToolChars?: number },
): number {
  const keepRecent = Math.max(1, opts?.keepRecentToolTurns ?? 2);
  const maxTool = Math.max(1_500, opts?.maxToolChars ?? 4_000);
  const before = estimateChatPayloadChars(messages);
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'tool') toolIdx.push(i);
  }
  const keepFrom = toolIdx.length <= keepRecent ? -1 : toolIdx[toolIdx.length - keepRecent]!;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool') {
      const text = chatContentToText(m.content);
      if (i < keepFrom) {
        const pathM = text.match(/\bpath=([^\s\]]+)/);
        const stub = pathM
          ? `[tool stub · path=${pathM[1]} · truncated for infra retry]`
          : '[tool stub · truncated for infra retry]';
        m.content = stub;
      } else if (text.length > maxTool) {
        m.content = `${text.slice(0, maxTool)}\n…(infra-retry truncate ${text.length}→${maxTool})`;
      }
    } else if (m.role === 'assistant' && !m.tool_calls?.length) {
      const text = chatContentToText(m.content);
      if (text.length > 2_500 && i < messages.length - 4) {
        m.content = `${text.slice(0, 1_200)}\n…(infra-retry truncate assistant)`;
      }
    }
  }
  return Math.max(0, before - estimateChatPayloadChars(messages));
}

export function pushToolResultMessage(
  messages: ChatMessage[],
  toolCallId: string,
  output: string,
  toolName?: string,
  opts?: TruncateToolResultOpts,
): void {
  const body = truncateToolResultForLlm(output, toolName, opts);
  let pathHint = '';
  try {
    const doc = JSON.parse(body) as { path?: unknown; file?: unknown };
    const p = typeof doc.path === 'string' ? doc.path : typeof doc.file === 'string' ? doc.file : '';
    if (p.trim()) pathHint = p.trim().replace(/\\/g, '/');
  } catch {
    const m = body.match(/(?:^|\n)(?:Wrote|Updated|Read)\s+(\S+)/i);
    if (m?.[1]) pathHint = m[1].replace(/\\/g, '/');
  }
  const tag = [
    toolName ? `tool=${toolName}` : null,
    pathHint ? `path=${pathHint}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  messages.push({
    role: 'tool',
    tool_call_id: toolCallId,
    content: tag ? `[${tag}]\n${body}` : body,
  });
}

/** Prefer patch/edit target paths; never fall back to whole-tree snapshots. */
export function collectAutoCheckpointPaths(
  toolName: string,
  args: Record<string, unknown>,
  recentReads: Set<string>,
): string[] {
  const out: string[] = [];
  const push = (p: unknown) => {
    if (typeof p === 'string' && p.trim()) out.push(p.trim().replace(/\\/g, '/'));
  };
  push(args.path);
  push(args.new_path);
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (f && typeof f === 'object') push((f as { path?: unknown }).path);
    }
  }
  if (typeof args.patch === 'string') {
    for (const m of args.patch.matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/gm)) {
      push(m[1]?.trim());
    }
  }
  if (
    !out.length
    && (toolName === 'apply_patch' || toolName === 'edit_file' || toolName === 'write_file')
  ) {
    for (const p of recentReads) push(p);
  }
  return [...new Set(out)].slice(0, 40);
}

