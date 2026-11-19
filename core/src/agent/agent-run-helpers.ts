import path from 'node:path';
import type { ChatMessage } from '../providers/openai-compatible.js';
import { chatContentToText } from '../providers/openai-compatible.js';
import type { AgentToolCall } from './tools.js';
import {
  buildCodeAgentUserContent,
  formatMultimodalSystemNote,
} from './agent-multimodal.js';
import {
  buildConversationImageCatalog,
  formatConversationImageCatalogNote,
  formatHistoryImageMarker,
} from './conversation-image-catalog.js';
import { enrichWorkspaceIndexContext } from './index/public.js';
import { buildDevWorkspaceContext } from './dev-workspace-fs.js';
import { extractUncOrDrivePaths } from './path-hints.js';
import {
  formatPatchFormatConstraints,
} from './agent-planner.js';
import { sanitizeHistoryForModel, looksLikeTruncatedAssistantReply } from '../chat/chat-filters.js';
import { applyHistoryContentBudget } from '../chat/history-budget.js';
import { buildSessionHistoryBudgetOpts } from '../chat/session-history-budget.js';
import { loadAgentRunMeta } from './agent-run-meta.js';
import { loadHarnessPolicy } from '../providers/harness-policy.js';
import { resolveContextBudgets } from '../providers/model-context-limits.js';
import type { CodeAgentOptions } from './agent-run-types.js';
import type { EvidenceRecord } from './agent-evidence-types.js';
import { formatEvidenceEnvelope } from './agent-evidence-store.js';
import { TOKEN_EFFICIENCY_PRINCIPLES } from './agent-token-efficiency.js';
import { UNTRUSTED_CONTENT_SYSTEM_RULE } from './untrusted-content.js';
import { formatTurnContextMessage, formatWorkspaceContextMessage } from './agent-context-assembler.js';
import { loadTurnContextRecords, turnContextKey } from './agent-turn-context-store.js';
import type { SessionMessage } from '../sessions/types.js';

const CODE_SNIPPET_MAX = 1200;

/**
 * Reply language. Agent prompts, tool results and runtime nudges are mostly English,
 * which made long runs drift into English/Japanese final answers for Korean users.
 * Static system line (cache-safe) + a short per-turn reminder near the latest request.
 */
export const AGENT_REPLY_LANGUAGE_RULE = [
  '## Reply language',
  '- Write every user-facing sentence (final answers, progress/status text, questions, summaries) in Korean (한국어).',
  '- This holds even when the system prompt, tool output, logs, code, or runtime notes are in English, and even if an earlier assistant turn was not in Korean.',
  '- Never answer in Japanese or Chinese. Use English only when the user\'s latest message is written entirely in English or the user explicitly asks for another language.',
  '- Keep code, identifiers, paths, commands and quoted source text as-is; explain them in Korean.',
].join('\n');

export const AGENT_REPLY_LANGUAGE_REMINDER =
  '### Reply language\n사용자에게 보이는 답변은 한국어로 작성하세요(사용자가 영어로만 쓰거나 다른 언어를 요청한 경우만 예외). 코드·경로·명령은 원문 유지.';

export function codingTaxSystemLines(): string[] {
  return [
    'Mutate rules: read_file (or list_directory for new files) before write/edit/delete/apply_patch — auto-heal may read for you. Prefer edit_file (one) / apply_patch (multi). No chat-only full-file paste. The built-in agent owns IDE mutations so Responses continuity, approvals, cache invalidation, and verification remain in one runtime.',
    'HITL Accept: delete_file, run_terminal, workspace_rollback, freeform plugin_install (no template_id), plugin_set_enabled (and oversized write/patch), git_commit/pull/push/switch/init, git_branch create, git_restore worktree|both, git_stash pop|drop (still pass confirm=true only when the user asked). Workspace git_* for the bound repo — but public remote inspect (github.com URL + 설명/구조) → run_terminal `git clone --depth 1 <url> .my_agent_remote/<owner>__<repo>` then list/read. Full history asks → `remote_git_inspect` (ensure_full) — never ask for git bundle upload. Never force-push.',
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
  /** Stable overview sent in the Workspace context message (tree/repo map not repeated). */
  presentContext?: string,
): string {
  const focus = focusMessage?.trim() ?? '';
  try {
    const enriched = enrichWorkspaceIndexContext(
      workspaceRoot,
      fullContext,
      focus,
      {
        repoMapMaxChars: 6_000,
        queryMaxChars: 3_500,
        cqrRoot,
        presentContext,
      },
    );
    if (presentContext?.trim()) return enriched;
    return enriched || buildDevWorkspaceContext(workspaceRoot, {}, {
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
  productMemoryBlock = '',
  selfWorkspace = false,
): ChatMessage[] {
  const root = toPosix(path.resolve(opts.workspaceRoot));
  const noFolder = opts.fileAccess === 'none';
  const hasImages = (opts.imageDataUrls?.length ?? 0) > 0;
  const hasAttach = Boolean(opts.attachmentContext?.trim());
  const protocolLines = useClientToolProtocol
    ? [
        'Tools run in-process via TOOL_CALL: lines (see protocol note). Ollama/passthrough-off OWUI must use TOOL_CALL.',
      ]
    : noFolder
      ? ['Tools run in-process via native API tool_calls.']
      : [
        'Tools run in-process via native API tool_calls. Prefer read→edit_file/apply_patch→run_diagnostics/run_tests; git_commit/git_pull/git_push/git_switch/git_restore need confirm=true where required.',
      ];
  const selfUiLines = noFolder
    ? [
        'NO WORK FOLDER: this chat has no bound work folder. File, terminal, git, checkpoint and plugin tools are not available and calls to them fail.',
        'Use web/browser tools, scheduler, task history and memory tools only. Downloads and screenshots go to app data for this session, not to user files.',
        'If the request needs local files or commands, say that the user must connect a work folder to this chat (작업폴더 연결) — do not pretend to read or edit files.',
      ]
    : selfWorkspace
    ? [
        'MY Agent product workspace (self): product paths such as ui/workspace, core/src and shell/CqrPa.Shell are valid targets here.',
        'FORBIDDEN: dump ui-target-map / MainWindow.xaml / ChatPane / GeminiNavSidebar unless the user asked to edit those UI targets.',
        'GROUNDING: base file-content claims on a read — read_file in this run, or evidence stored earlier in this session (listed in the turn context; open it with evidence_read) while that file is unchanged.',
      ]
    : [
        'External project workspace — do NOT cite MY Agent paths (ui/workspace, ChatPane, MainWindow.xaml).',
        'GROUNDING: base file-content claims on a read — read_file in this run, or evidence stored earlier in this session (listed in the turn context; open it with evidence_read) while that file is unchanged. Discover via map/search/read (UNC/absolute OK when user points outside).',
      ];
  // AGENTS.md stays in both self and external memory; the self FORBIDDEN line above already
  // covers UI-map dumping, so the block is no longer cut at the AGENTS.md heading.
  const memoryForPrompt = String(productMemoryBlock || '');
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        opts.systemPrompt?.trim() ?? '',
        '',
        'You are one workspace agent. Decide from the conversation whether to explain, inspect, plan, mutate, or call tools.',
        'The local runtime does not classify the request or choose tools for you.',
        AGENT_REPLY_LANGUAGE_RULE,
        '## General Work Principles',
        '- Keep responses concise and lead with the result. Omit unnecessary background, repetition, and examples unless requested.',
        '- For implementation requests, complete discovery, modification, and verification in the current run when practical. Do not modify files or run tests for explanation-only requests.',
        '- Limit changes and tool calls to the minimum scope needed to satisfy the request.',
        '- For initial discovery, issue independent read-only searches and reads together in one model response, then decide from the combined results. Do not serialize independent background exploration.',
        '- Use risk-proportionate verification. Start with the narrowest check that directly validates the change, and stop when sufficient evidence is obtained.',
        '- Use content review for documentation, diagnostics for static changes, targeted tests for runtime behavior, and browser or execution checks for user-facing behavior.',
        '- Expand verification for high-risk changes involving security, authentication, persistent data, installation, or updates.',
        '- Do not repeat successful checks unless relevant code changed. Run the full test suite only when the impact is broad or targeted checks are insufficient.',
        '- Never claim unverified work as complete. Clearly report any untested areas, failures, or remaining uncertainty.',
        '- Before stating that a file, setting, command, or data does not exist in the workspace, search or list for it (or rely on stored evidence). The repository map and retrieval hits in the context are truncated and are not proof of absence.',
        '- Minimize token usage and tool output by avoiding redundant searches, repeated tests, and unnecessary logs—without sacrificing correctness or safety.',
        ...TOKEN_EFFICIENCY_PRINCIPLES,
        'Track multi-turn work with active_task. Remaining work is not a blocker: when the next step can be attempted now, do it in this run instead of stopping. If accepted work still cannot finish in this run, call active_task set (the task stays active) before answering and say what remains.',
        'Use active_task block only when the next required step cannot be attempted now: the user declined an approval, a required input or decision is missing, a tool error could not be resolved after trying alternatives, or an external dependency or limit prevents it. Name that condition in blocker. "Not implemented yet", "not verified yet", or "not finished" is never a blocker.',
        'On later turns reconcile the task with the latest request and never silently drop it. When the user asks to continue a blocked task, re-check whether the blocker still applies and resume it with active_task set. Call active_task complete once the acceptance condition is met and checked. User correction may replace/cancel it.',
        'Tools run locally inside this app. Do not say that you cannot edit files, that a tool or tool server is missing, or that the app needs a restart, unless a tool result in this run reported exactly that.',
        UNTRUSTED_CONTENT_SYSTEM_RULE,
        noFolder
          ? 'Browser and web download tools are available in this chat. Do not tell the user that there is no internet access.'
          : 'A terminal (run_terminal) and network access are available. Do not tell the user that there is no terminal or internet, that a public GitHub repository cannot be cloned, or ask them to run commands locally and paste the output or to upload a git bundle. Clone public repositories with run_terminal (an approval prompt may appear). After a clone succeeded in this run, do not later describe that result as unverified (미검증).',
        noFolder ? `Session scratch folder (app data, not user files): ${root}` : `Dev workspace root (not an FS cage): ${root}`,
        noFolder
          ? ''
          : 'Relative paths resolve here; absolute/UNC allowed when the user points outside. NAS writes need consent. Do not ask to copy NAS files in — list/read UNC directly.',
        `Available tools: ${toolNames.join(', ')}.`,
        ...protocolLines,
        ...selfUiLines,
        'Preserve useful findings and answer in the form best suited to the user request.',
        noFolder ? '' : formatPatchFormatConstraints(),
        memoryForPrompt,
        // Message-dependent notes (UI path hints, multimodal, image catalog) live in the
        // turn context below; in the system prefix they broke cross-question caching.
        '',
        useClientToolProtocol
          ? 'Protocol: TOOL_CALL JSON first line (see TOOL_CALL protocol note). No XML/<invoke>.'
          : '',
        // The query-dependent workspace snapshot is in the turn context message, keeping
        // this system prefix byte-identical across turns for provider prompt caching.
        'The stable workspace overview (memory, folder tree, repository map) is in the "## Workspace context" message before the conversation history. Per-request retrieval hits, active task and TODO ledger arrive in the "## Turn context" message before the latest user request.',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  // Stable overview once, before history: replaying it with every earlier turn grew the
  // history ~19k chars per question and kept tripping the compress threshold.
  const stableWorkspace = opts.stableWorkspaceContext?.trim() ?? '';
  if (stableWorkspace) {
    messages.push({ role: 'user', content: formatWorkspaceContextMessage(stableWorkspace) });
  }
  // Replay each earlier turn's exact turn context + user content so a new question's
  // prompt extends the previous request byte-for-byte (provider prompt cache prefix).
  const sanitizedHistory = sanitizeHistoryForModel(opts.history ?? []);
  const turnContexts = loadTurnContextRecords(opts.cqrRoot, opts.sessionId);
  const historyWithReplay = sanitizedHistory.map((m, i) => {
    if (m.role !== 'user') return m;
    // Replay is text-only: mark image turns so they stay tied to the image catalog ids.
    const imageNote = formatHistoryImageMarker(m);
    const rec = turnContexts.size
      ? turnContexts.get(turnContextKey(sanitizedHistory[i - 1]?.at, m.content ?? ''))
      : undefined;
    if (!rec && !imageNote) return m;
    return {
      ...m,
      ...(rec ? { model_context: rec.context, model_user: rec.user } : {}),
      ...(imageNote ? { model_image_note: imageNote } : {}),
    };
  });
  for (const m of applyHistoryContentBudget(
    historyWithReplay as Array<SessionMessage & { model_context?: string; model_user?: string; model_image_note?: string }>,
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
    const withImageNote = (text: string): string =>
      m.model_image_note ? (text.trim() ? `${text}\n\n${m.model_image_note}` : m.model_image_note) : text;
    if (m.role === 'user' && typeof m.model_context === 'string') {
      messages.push({ role: 'user', content: m.model_context });
      messages.push({ role: 'user', content: withImageNote(typeof m.model_user === 'string' ? m.model_user : m.content) });
    } else if (m.role === 'user') {
      messages.push({ role: 'user', content: withImageNote(m.content) });
    } else if (m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  }
  // No-folder chats: the scratch dir has no project files worth indexing.
  const turnSnapshot = noFolder
    ? String(opts.workspaceContext ?? '').trim()
    : workspaceSnapshot(
      opts.workspaceRoot,
      opts.workspaceContext,
      opts.userMessage,
      opts.cqrRoot,
      stableWorkspace || undefined,
    ).trim();
  const turnContext = formatTurnContextMessage([
    AGENT_REPLY_LANGUAGE_REMINDER,
    formatMultimodalSystemNote(hasImages, hasAttach, false),
    formatConversationImageCatalogNote(buildConversationImageCatalog(opts.history)),
    turnSnapshot
      ? [
          stableWorkspace
            ? '### Request-scoped workspace hints (discovery context only; read concrete files before file-content claims)'
            : '### Workspace files (discovery context only; read concrete files before file-content claims)',
          turnSnapshot,
        ].join('\n')
      : '',
  ]);
  if (turnContext) messages.push(turnContext);
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

export type ToolResultProjectionOpts = {
  modelId?: string | null;
  maxChars?: number;
};

/** Request-scoped evidence projection budget (set for the duration of runAgentStepLoop). */
let activeToolBudget: ToolResultProjectionOpts | null = null;

export async function runWithToolBudget<T>(
  opts: ToolResultProjectionOpts,
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

function resolveToolMaxChars(opts?: ToolResultProjectionOpts): number {
  const merged: ToolResultProjectionOpts = { ...activeToolBudget, ...opts };
  if (typeof merged.maxChars === 'number' && merged.maxChars > 0) return merged.maxChars;
  if (merged.modelId) return resolveContextBudgets(merged.modelId).toolResultMaxChars;
  return loadHarnessPolicy().toolResultMaxChars;
}

function evidenceProjectionRequired(
  record: EvidenceRecord,
  output: string,
  maxChars: number,
): string {
  const lines = output.split(/\r?\n/);
  const totalLines = Math.max(1, lines.length);
  const averageCharsPerLine = Math.max(1, output.length / totalLines);
  const suggestedMaxLines = Math.max(1, Math.floor(maxChars / averageCharsPerLine));
  return JSON.stringify({
    status: 'selection_required',
    evidenceId: record.evidenceId,
    complete: false,
    evidenceComplete: record.complete,
    bytes: record.bytes,
    fingerprint: record.fingerprint,
    returnedRanges: [],
    omittedRanges: [{ start: 1, end: totalLines }],
    suggestedMaxLines,
    message: 'Exact evidence is stored. Call evidence_read with one or more smaller line ranges; no partial body was projected.',
    next: {
      tool: 'evidence_read',
      arguments: {
        evidence_id: record.evidenceId,
        lines: [{ start: 1, end: Math.min(totalLines, suggestedMaxLines) }],
      },
    },
  }, null, 2);
}

/**
 * Project exact evidence into a model request without semantically blind head/tail truncation.
 * Oversized bodies remain exact in the Evidence Store and become an explicit selection request.
 */
export function projectEvidenceForModel(
  record: EvidenceRecord,
  output: string,
  opts?: ToolResultProjectionOpts,
): string {
  const exact = formatEvidenceEnvelope(record, String(output ?? ''));
  const maxChars = resolveToolMaxChars(opts);
  return exact.length <= maxChars
    ? exact
    : evidenceProjectionRequired(record, String(output ?? ''), maxChars);
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

export function pushToolResultMessage(
  messages: ChatMessage[],
  toolCallId: string,
  output: string,
  toolName?: string,
): void {
  const body = String(output ?? '');
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

/**
 * Every path an apply_patch call names, including move destinations
 * (`files[].new_path`, `*** Move to:`). Header matching mirrors parsePatchText.
 */
function collectPatchTargetPaths(args: Record<string, unknown>, push: (p: unknown) => void): void {
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (f && typeof f === 'object') {
        push((f as { path?: unknown }).path);
        push((f as { new_path?: unknown }).new_path);
      }
    }
  }
  if (typeof args.patch === 'string') {
    for (const m of args.patch.matchAll(/^\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$/gim)) {
      push(m[1]);
    }
    for (const m of args.patch.matchAll(/^\*\*\*\s*(?:Move|Rename) (?:File|to):\s*(.+?)\s*$/gim)) {
      push(m[1]);
    }
  }
}

/**
 * Paths a successful mutating call changed on disk. This is the change-review list,
 * and reject only rolls back paths on it — so a rename/move must report BOTH the old
 * and the new path, or reject deletes the new one without restoring the old one.
 */
export function collectMutatedPathsForTool(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const push = (p: unknown) => {
    if (typeof p === 'string' && p.trim()) out.push(p.trim().replace(/\\/g, '/'));
  };
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'delete_file') {
    push(args.path);
  } else if (toolName === 'rename_file') {
    push(args.path);
    push(args.new_path ?? args.to);
  } else if (toolName === 'apply_patch') {
    push(args.path);
    push(args.new_path);
    collectPatchTargetPaths(args, push);
  }
  return [...new Set(out)];
}

/**
 * Old → new path pairs of a rename/move call. Recorded on the checkpoint after the
 * call succeeds so that rejecting one path of the pair also rolls back the other.
 */
export function collectMovePairsForTool(
  toolName: string,
  args: Record<string, unknown>,
): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const norm = (p: unknown) => (typeof p === 'string' ? p.trim().replace(/\\/g, '/') : '');
  const push = (fromRaw: unknown, toRaw: unknown) => {
    const from = norm(fromRaw);
    const to = norm(toRaw);
    if (from && to && from !== to && !out.some((m) => m.from === from && m.to === to)) {
      out.push({ from, to });
    }
  };
  if (toolName === 'rename_file') {
    push(args.path, args.new_path ?? args.to);
  } else if (toolName === 'apply_patch') {
    push(args.path, args.new_path);
    if (Array.isArray(args.files)) {
      for (const f of args.files) {
        if (f && typeof f === 'object') {
          push((f as { path?: unknown }).path, (f as { new_path?: unknown }).new_path);
        }
      }
    }
    if (typeof args.patch === 'string') {
      let current = '';
      for (const line of args.patch.split(/\r?\n/)) {
        const header = line.match(/^\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$/i);
        if (header) {
          current = header[1];
          continue;
        }
        const move = line.match(/^\*\*\*\s*(?:Move|Rename) (?:File|to):\s*(.+?)\s*$/i);
        if (move && current) push(current, move[1]);
      }
    }
  }
  return out;
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
  if (toolName === 'rename_file') push(args.to);
  collectPatchTargetPaths(args, push);
  if (
    !out.length
    && (toolName === 'apply_patch' || toolName === 'edit_file' || toolName === 'write_file')
  ) {
    for (const p of recentReads) push(p);
  }
  return [...new Set(out)].slice(0, 40);
}

