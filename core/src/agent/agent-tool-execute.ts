/**
 * Tool execution for the code agent (split from tools.ts).
 */
import {
  editWorkspaceFile,
  listWorkspaceDirectory,
  searchWorkspaceFiles,
  writeWorkspaceFile,
} from './dev-workspace-fs.js';
import { formatEmptyRetrievalHint, formatToolSelfCorrection } from './tool-self-correction.js';
import { extractPathsFromUserMessage } from './agent-outcome-gate.js';
import {
  formatRunTerminalOutput,
  gitBlame,
  gitBranch,
  gitCommit,
  gitDiff,
  gitFetch,
  gitLog,
  gitHistoryTree,
  gitInit,
  gitPull,
  gitPush,
  gitRestore,
  gitShow,
  gitStage,
  gitStash,
  gitStatus,
  gitSwitch,
  gitSyncPreview,
  runTerminalCommandAsync,
} from './run-terminal.js';
import { remoteGitInspect } from './remote-git-inspect.js';
import { runAstGrepSidecar, runRepomixSidecar } from '../sidecars/cli-search-sidecars.js';
import { runMarkitdownSidecar } from '../sidecars/markitdown-sidecar.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  formatPluginListJson,
  getAgentPluginByToolName,
  installAgentPlugin,
  installAgentPluginFromTemplate,
  listEnabledPluginToolDefinitions,
  scaffoldAgentPlugin,
  setAgentPluginEnabled,
} from './agent-plugin-store.js';
import { runAgentPlugin } from './agent-plugin-runner.js';
import { callUserMcpTool } from './user-mcp.js';
import { runWorkspaceTests } from './run-tests.js';
import { runWorkspaceDiagnostics } from './run-diagnostics.js';
import {
  createWorkspaceCheckpoint,
  listWorkspaceCheckpoints,
  rollbackWorkspaceCheckpoint,
} from './agent-checkpoint.js';
import {
  applyFilePatches,
  deleteWorkspaceFile,
  formatApplyPatchOutput,
  renameWorkspaceFile,
  resolveApplyPatchArgs,
} from './apply-patch.js';
import {
  queryRepoMap,
  searchEmbeddingIndexAsync,
} from './index/public.js';
import { BROWSER_AGENT_TOOLS, CODE_AGENT_TOOL_NAMES, CODE_AGENT_TOOLS } from './agent-tool-definitions.js';
import { isPlaywrightAvailable } from '../browser/playwright-probe.js';
import { isPlaceholderNavUrl } from '../browser/browser-service.js';
import { saveWebAsset } from '../sessions/save-web-asset.js';
import { isOfficeBinaryPath, normalizeWindowsPermissionError } from '../security/workspace-capabilities.js';
import { appendPostMutateSyntaxCheck } from './agent-post-mutate-syntax.js';
import { isMutatingAgentTool } from './verify-loop.js';
import {
  loadAgentRunMeta,
  setSessionActiveTask,
  type SessionActiveTask,
} from './agent-run-meta.js';
import { normalizeToolCall, parseToolArgs } from './agent-tool-normalize.js';
import type { AgentToolCall, AgentToolContext } from './agent-tool-types.js';
import {
  getTaskLedgerDetail,
  searchTaskLedger,
  type TaskLedgerDetailSection,
  type TaskLedgerStatus,
} from './task-ledger.js';
import {
  formatBareModuleReadBlock,
  isBlockedBareModuleRead,
} from './agent-bare-module-guard.js';
import {
  invalidateWorkspaceReadCache,
  readWorkspaceFileThroughCache,
} from './agent-read-through-cache.js';
import { getPersonalSchedulerRuntime } from '../scheduler/runtime-registry.js';
import type { SchedulerTaskInput } from '../scheduler/types.js';

function availableToolNames(cqrRoot?: string): string[] {
  const base = cqrRoot && isPlaywrightAvailable(cqrRoot)
    ? [...CODE_AGENT_TOOLS, ...BROWSER_AGENT_TOOLS].map((t) => t.function.name)
    : [...CODE_AGENT_TOOL_NAMES];
  if (!cqrRoot) return base;
  try {
    const pluginNames = listEnabledPluginToolDefinitions(cqrRoot).map((t) => t.function.name);
    return [...base, ...pluginNames.filter((n) => !base.includes(n))];
  } catch {
    return base;
  }
}

function appendPostMutateGates(
  workspaceRoot: string,
  paths: string[],
  output: string,
): string {
  return appendPostMutateSyntaxCheck(workspaceRoot, paths, output);
}

export async function executeAgentTool(
  workspaceRoot: string,
  call: AgentToolCall,
  guard: import('../security/dev-workspace-guard.js').WorkspaceGuardOptions = {},
  ctx?: AgentToolContext,
): Promise<{ output: string; label: string }> {
  const normalized = normalizeToolCall(call);
  const args = parseToolArgs(normalized.function.arguments);
  const name = normalized.function.name;

  if (
    ctx?.workspaceBehavior === 'plan'
    && isMutatingAgentTool(name)
  ) {
    return {
      label: name,
      output: 'ERROR: WORKSPACE_BEHAVIOR_READ_ONLY — Plan mode forbids mutating tools. Switch to Agent mode to edit files.',
    };
  }

  try {
    switch (name) {
      case 'scheduler_list': {
        if (!ctx?.cqrRoot) throw new Error('CQR root is unavailable');
        const runtime = getPersonalSchedulerRuntime(ctx.cqrRoot);
        if (!runtime) throw new Error('Personal scheduler is not running with the Core API');
        const tasks = runtime.service.listTasks();
        return {
          label: `scheduler tasks (${tasks.length})`,
          output: JSON.stringify({
            count: tasks.length,
            tasks,
            weekly_queue: runtime.service.getWeeklyQueue(),
          }),
        };
      }
      case 'scheduler_feed': {
        if (!ctx?.cqrRoot) throw new Error('CQR root is unavailable');
        const runtime = getPersonalSchedulerRuntime(ctx.cqrRoot);
        if (!runtime) throw new Error('Personal scheduler is not running with the Core API');
        const items = runtime.service.listFeed(Number(args.limit ?? 20));
        return {
          label: `scheduler feed (${items.length})`,
          output: JSON.stringify({ count: items.length, items }),
        };
      }
      case 'scheduler_upsert': {
        if (!ctx?.cqrRoot) throw new Error('CQR root is unavailable');
        const runtime = getPersonalSchedulerRuntime(ctx.cqrRoot);
        if (!runtime) throw new Error('Personal scheduler is not running with the Core API');
        const task = runtime.service.saveTask({
          name: String(args.name ?? ''),
          description: String(args.description ?? ''),
          instruction: String(args.instruction ?? ''),
          triggers: args.triggers as SchedulerTaskInput['triggers'],
          enabled: args.enabled !== false,
          misfire_policy: args.misfire_policy === 'run_once' ? 'run_once' : 'skip',
        }, typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined);
        return { label: `scheduler saved (${task.name})`, output: JSON.stringify({ ok: true, task }) };
      }
      case 'scheduler_set_state': {
        if (!ctx?.cqrRoot) throw new Error('CQR root is unavailable');
        const runtime = getPersonalSchedulerRuntime(ctx.cqrRoot);
        if (!runtime) throw new Error('Personal scheduler is not running with the Core API');
        const id = String(args.id ?? '').trim();
        const action = String(args.action ?? '').trim();
        if (!id) throw new Error('id is required');
        if (action === 'enable') {
          const task = runtime.service.setEnabled(id, true);
          return { label: `scheduler enabled (${task.name})`, output: JSON.stringify({ ok: true, task }) };
        }
        if (action === 'pause') {
          const task = runtime.service.setEnabled(id, false);
          return { label: `scheduler paused (${task.name})`, output: JSON.stringify({ ok: true, task }) };
        }
        if (action === 'delete') {
          return { label: 'scheduler deleted', output: JSON.stringify({ ok: true, deleted: runtime.service.deleteTask(id) }) };
        }
        if (action === 'run_now') {
          const run = runtime.runNow(id);
          return { label: 'scheduler run queued', output: JSON.stringify({ ok: true, run }) };
        }
        throw new Error(`Unsupported scheduler action: ${action}`);
      }
      case 'active_task': {
        if (!ctx?.cqrRoot || !ctx.sessionId) {
          return { label: 'active task', output: 'ERROR: active_task requires a session context' };
        }
        const action = String(args.action || '').trim();
        const previous = loadAgentRunMeta(ctx.cqrRoot, ctx.sessionId).activeTask ?? null;
        if (action === 'set') {
          const objective = String(args.objective || '').trim();
          const acceptance = String(args.acceptance || '').trim();
          if (!objective || !acceptance) {
            return { label: 'active task', output: 'ERROR: active_task set requires objective and acceptance' };
          }
          const task: SessionActiveTask = {
            updatedAt: new Date().toISOString(),
            status: 'active',
            objective,
            acceptance,
            relatedPaths: Array.isArray(args.related_paths)
              ? args.related_paths.map((p) => String(p)).filter(Boolean)
              : undefined,
          };
          setSessionActiveTask(ctx.cqrRoot, ctx.sessionId, task);
          return { label: 'active task set', output: JSON.stringify({ ok: true, activeTask: task }) };
        }
        if (!previous) {
          return { label: 'active task', output: `ERROR: active_task ${action || '(empty)'} requires an existing task` };
        }
        if (action === 'block') {
          const blocker = String(args.blocker || '').trim();
          if (!blocker) return { label: 'active task', output: 'ERROR: active_task block requires blocker' };
          const task: SessionActiveTask = {
            ...previous,
            updatedAt: new Date().toISOString(),
            status: 'blocked',
            blocker,
          };
          setSessionActiveTask(ctx.cqrRoot, ctx.sessionId, task);
          return { label: 'active task blocked', output: JSON.stringify({ ok: true, activeTask: task }) };
        }
        if (action === 'complete') {
          const evidence = ctx.getRunEvidence?.();
          const strong = Boolean(
            evidence
            && evidence.mutatedPaths.length > 0
            && evidence.acceptanceOk,
          );
          if (!strong) {
            return {
              label: 'active task completion rejected',
              output: 'ERROR: ACTIVE_TASK_COMPLETION_REQUIRES_MUTATE_AND_EXPLICIT_ACCEPTANCE',
            };
          }
          const task: SessionActiveTask = {
            ...previous,
            updatedAt: new Date().toISOString(),
            status: 'done',
            blocker: undefined,
            closeReason: String(args.reason || 'explicit Acceptance evidence').trim(),
            relatedPaths: evidence!.mutatedPaths,
          };
          setSessionActiveTask(ctx.cqrRoot, ctx.sessionId, task);
          return { label: 'active task complete', output: JSON.stringify({ ok: true, activeTask: task }) };
        }
        if (action === 'cancel') {
          const reason = String(args.reason || '').trim();
          if (!reason) return { label: 'active task', output: 'ERROR: active_task cancel requires reason' };
          const task: SessionActiveTask = {
            ...previous,
            updatedAt: new Date().toISOString(),
            status: 'cancelled',
            blocker: undefined,
            closeReason: reason,
          };
          setSessionActiveTask(ctx.cqrRoot, ctx.sessionId, task);
          return { label: 'active task cancelled', output: JSON.stringify({ ok: true, activeTask: task }) };
        }
        return { label: 'active task', output: `ERROR: unsupported active_task action: ${action}` };
      }
      case 'task_history_search': {
        if (!ctx?.cqrRoot) throw new Error('CQR root is unavailable');
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('query is required');
        const results = searchTaskLedger(ctx.cqrRoot, {
          query,
          limit: Number(args.limit ?? 5),
          sessionId: args.session_id ? String(args.session_id) : undefined,
          workspaceRoot: args.workspace_root ? String(args.workspace_root) : undefined,
          status: args.status ? String(args.status) as TaskLedgerStatus : undefined,
        });
        return { label: `task history search (${results.length})`, output: JSON.stringify({ query, count: results.length, results }) };
      }
      case 'task_history_detail': {
        if (!ctx?.cqrRoot) throw new Error('CQR root is unavailable');
        const taskId = String(args.task_id ?? '').trim();
        if (!taskId) throw new Error('task_id is required');
        const section = String(args.section ?? 'summary') as TaskLedgerDetailSection;
        const detail = getTaskLedgerDetail(ctx.cqrRoot, taskId, section);
        if (!detail) throw new Error(`Task history not found: ${taskId}`);
        return { label: `task history detail (${section})`, output: JSON.stringify({ section, detail }) };
      }
      case 'list_directory': {
        const rel = typeof args.path === 'string' ? args.path : '.';
        const listed = listWorkspaceDirectory(workspaceRoot, rel, guard);
        return {
          label: `list ${listed.path}`,
          output: JSON.stringify(listed, null, 2),
        };
      }
      case 'read_file': {
        const rel = String(args.path ?? '');
        if (isOfficeBinaryPath(rel)) {
          return { label: `read ${rel}`, output: 'ERROR: OFFICE_BINARY_REQUIRES_DOCUMENT_TOOL\nExcel/PowerPoint 파일은 UTF-8 텍스트로 읽지 않습니다. Office 전용 추출 또는 승인된 버전 복사 워크플로를 사용하세요.' };
        }
        if (isBlockedBareModuleRead(workspaceRoot, rel)) {
          return {
            label: `read ${rel}`,
            output: formatBareModuleReadBlock(rel),
          };
        }
        const read = readWorkspaceFileThroughCache({
          cqrRoot: ctx?.cqrRoot,
          workspaceRoot,
          relPath: rel,
          guard,
          fresh: args.fresh === true,
          startLine: typeof args.start_line === 'number' ? args.start_line : undefined,
          endLine: typeof args.end_line === 'number' ? args.end_line : undefined,
        });
        const bytes = Buffer.byteLength(read.text, 'utf8');
        const meta = [
          '[read_file meta]',
          `path=${rel}`,
          `lines=${read.start_line}-${read.end_line}/${read.total_lines}`,
          `bytes=${bytes}`,
          `cache=${read.cache}`,
          `stat=${read.stat_fingerprint.slice(0, 16)}`,
          `sha256=${read.content_sha256}`,
        ].join(' ') + '\n';
        return { label: `read ${rel}`, output: meta + read.text };
      }
      case 'write_file': {
        const rel = String(args.path ?? '');
        if (isOfficeBinaryPath(rel)) {
          return { label: `write ${rel}`, output: 'ERROR: OFFICE_BINARY_REQUIRES_DOCUMENT_TOOL\n텍스트 쓰기로 Office 파일을 덮어쓸 수 없습니다. 원본을 보존하고 새 버전 파일로 생성하세요.' };
        }
        const content = String(args.content ?? '');
        if (!content.trim()) {
          return {
            label: `write ${rel}`,
            output:
              'ERROR: write_file requires non-empty "content" in TOOL_CALL arguments. '
              + 'Include the full file body as a JSON string (use \\n for newlines), '
              + 'or add a fenced code block after the TOOL_CALL line.',
          };
        }
        writeWorkspaceFile(workspaceRoot, rel, content, guard);
        invalidateWorkspaceReadCache(ctx?.cqrRoot, workspaceRoot, rel);
        return {
          label: `write ${rel}`,
          output: appendPostMutateGates(
            workspaceRoot,
            [rel],
            `Wrote ${rel} (${content.length} chars)`,
          ),
        };
      }
      case 'edit_file': {
        const rel = String(args.path ?? '');
        if (isOfficeBinaryPath(rel)) {
          return { label: `edit ${rel}`, output: 'ERROR: OFFICE_BINARY_REQUIRES_DOCUMENT_TOOL\n텍스트 편집으로 Office 파일을 수정할 수 없습니다. 원본을 보존하고 새 버전 파일로 생성하세요.' };
        }
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        const fullContent = String(args.content ?? '');
        const replaceAll = args.replace_all === true;
        if (!oldText && (newText || fullContent)) {
          const content = newText || fullContent;
          writeWorkspaceFile(workspaceRoot, rel, content, guard);
          invalidateWorkspaceReadCache(ctx?.cqrRoot, workspaceRoot, rel);
          return {
            label: `write ${rel}`,
            output: appendPostMutateGates(
              workspaceRoot,
              [rel],
              `Wrote ${rel} (${content.length} chars)`,
            ),
          };
        }
        const result = editWorkspaceFile(
          workspaceRoot,
          rel,
          oldText,
          newText,
          guard,
          replaceAll,
        );
        const body = JSON.stringify(result);
        if (result.ok) invalidateWorkspaceReadCache(ctx?.cqrRoot, workspaceRoot, rel);
        return {
          label: `edit ${rel}`,
          output: result.ok
            ? appendPostMutateGates(workspaceRoot, [rel], body)
            : `ERROR: edit_file_failed path=${rel}\n${body}`,
        };
      }
      case 'apply_patch': {
        const patches = resolveApplyPatchArgs(args);
        if (!patches.length) {
          return {
            label: 'apply_patch',
            output:
              'ERROR: apply_patch requires "patch" text, or "files" array, or path+edits.\n'
              + 'Format constraints: unique old_text with ≥2 context lines; atomic multi-file.\n'
              + 'Example:\n*** Begin Patch\n*** Update File: a.ts\n@@\n context\n-old\n+new\n*** End Patch',
          };
        }
        if (patches.some((patch) => isOfficeBinaryPath(patch.path) || (patch.new_path && isOfficeBinaryPath(patch.new_path)))) {
          return { label: 'apply_patch', output: 'ERROR: OFFICE_BINARY_REQUIRES_DOCUMENT_TOOL\napply_patch로 Office 바이너리를 변경할 수 없습니다. 새 버전 파일 생성 워크플로를 사용하세요.' };
        }
        const result = applyFilePatches(workspaceRoot, patches, guard);
        const body = formatApplyPatchOutput(result);
        if (!result.ok) {
          return { label: 'apply_patch', output: `ERROR: apply_patch_failed\n${body}` };
        }
        for (const applied of result.applied) {
          invalidateWorkspaceReadCache(ctx?.cqrRoot, workspaceRoot, applied.path);
        }
        const paths = result.applied
          .filter((a) => a.action !== 'delete')
          .map((a) => a.path);
        return {
          label: 'apply_patch',
          output: appendPostMutateGates(workspaceRoot, paths, body),
        };
      }
      case 'delete_file': {
        const rel = String(args.path ?? '');
        const result = deleteWorkspaceFile(workspaceRoot, rel, guard);
        invalidateWorkspaceReadCache(ctx?.cqrRoot, workspaceRoot, rel);
        return { label: `delete ${rel}`, output: JSON.stringify(result) };
      }
      case 'rename_file': {
        const rel = String(args.path ?? '');
        const dest = String(args.new_path ?? args.to ?? '');
        const result = renameWorkspaceFile(workspaceRoot, rel, dest, guard);
        invalidateWorkspaceReadCache(ctx?.cqrRoot, workspaceRoot, rel);
        invalidateWorkspaceReadCache(ctx?.cqrRoot, workspaceRoot, dest);
        return { label: `rename ${rel}`, output: JSON.stringify(result) };
      }
      case 'search_files': {
        const query = String(args.query ?? '');
        const rel = typeof args.path === 'string' ? args.path : '.';
        const regex = args.regex === true;
        const hits = searchWorkspaceFiles(workspaceRoot, query, rel, guard, { regex });
        return { label: `search "${query}"`, output: JSON.stringify(hits, null, 2) };
      }
      case 'query_repo_map': {
        const query = String(args.query ?? '');
        const kind = typeof args.kind === 'string' ? args.kind : undefined;
        const maxResults =
          typeof args.max_results === 'number'
            ? args.max_results
            : typeof args.maxResults === 'number'
              ? args.maxResults
              : undefined;
        const hits = queryRepoMap(workspaceRoot, query, {
          kind: kind as
            | 'class'
            | 'function'
            | 'method'
            | 'type'
            | 'const'
            | 'interface'
            | 'enum'
            | undefined,
          maxResults,
        });
        let output = JSON.stringify({
          query,
          count: hits.length,
          authority: 'candidate_only',
          verify_with: 'read_file',
          hits,
        }, null, 2);
        if (!hits.length) {
          output += `\n\n${formatEmptyRetrievalHint(
            'query_repo_map',
            query,
            extractPathsFromUserMessage(query, 4),
          )}`;
        }
        return {
          label: `repo_map "${query}"`,
          output,
        };
      }
      case 'search_embeddings': {
        const query = String(args.query ?? '');
        const maxResults =
          typeof args.max_results === 'number'
            ? args.max_results
            : typeof args.maxResults === 'number'
              ? args.maxResults
              : 8;
        const result = await searchEmbeddingIndexAsync(workspaceRoot, query, {
          maxHits: maxResults,
          cqrRoot: ctx?.cqrRoot,
        });
        let output = JSON.stringify(
          {
            query,
            count: result.hits.length,
            engine: result.engine,
            fallback: result.fallback === true,
            authority: 'candidate_only',
            verify_with: 'read_file',
            hits: result.hits,
          },
          null,
          2,
        );
        if (!result.hits.length) {
          output += `\n\n${formatEmptyRetrievalHint(
            'search_embeddings',
            query,
            extractPathsFromUserMessage(query, 4),
          )}`;
        }
        return {
          label: `embed "${query}"`,
          output,
        };
      }
      case 'run_terminal': {
        const command = String(args.command ?? '').trim();
        if (/https?:\/\/[^\s]*대상|example\.com|--target\s*=\s*https?:\/\/[^\s]*(대상|example\.com|placeholder)/i.test(command)) {
          return {
            label: `run ${command.slice(0, 60)}`,
            output:
              'ERROR: Placeholder URL blocked. Do not run tests against https://대상-주소 / example.com. Use a real local or production URL, or skip remote HTTPS verification.',
          };
        }
        const run = await runTerminalCommandAsync(workspaceRoot, command, {
          signal: ctx?.signal,
          jobId: ctx?.sessionId ? `agent_${ctx.sessionId}` : undefined,
        });
        return {
          label: `run ${command.slice(0, 60)}`,
          output: formatRunTerminalOutput(run),
        };
      }
      case 'run_tests': {
        const command = typeof args.command === 'string' ? args.command : undefined;
        const output = runWorkspaceTests(workspaceRoot, { command });
        return { label: 'run_tests', output };
      }
      case 'run_diagnostics': {
        const command = typeof args.command === 'string' ? args.command : undefined;
        let changedPaths: string[] | undefined;
        if (ctx?.cqrRoot && ctx.sessionId) {
          const meta = loadAgentRunMeta(ctx.cqrRoot, ctx.sessionId);
          if (meta?.mutatedPaths?.length) changedPaths = meta.mutatedPaths;
        }
        const output = runWorkspaceDiagnostics(workspaceRoot, { command, changedPaths });
        return { label: 'run_diagnostics', output };
      }
      case 'workspace_checkpoint': {
        const cqrRoot = ctx?.cqrRoot;
        if (!cqrRoot) {
          return {
            label: 'workspace_checkpoint',
            output: 'ERROR: cqrRoot missing — cannot store checkpoint',
          };
        }
        const label = typeof args.label === 'string' ? args.label : undefined;
        const paths = Array.isArray(args.paths)
          ? args.paths.map((p) => String(p)).filter((p) => p.trim())
          : [];
        if (!paths.length) {
          return {
            label: 'workspace_checkpoint',
            output:
              'ERROR: paths required — list the files you will edit (full-tree snapshot is disabled to avoid multi-minute lag). Example: paths=["ui/workspace/src/components/EditorPane.tsx"]',
          };
        }
        const meta = createWorkspaceCheckpoint(workspaceRoot, cqrRoot, {
          sessionKey: ctx?.sessionId ?? 'default',
          label,
          paths,
          guard,
        });
        return {
          label: `checkpoint ${meta.id}`,
          output: JSON.stringify(meta, null, 2),
        };
      }
      case 'workspace_rollback': {
        const cqrRoot = ctx?.cqrRoot;
        if (!cqrRoot) {
          return {
            label: 'workspace_rollback',
            output: 'ERROR: cqrRoot missing — cannot rollback',
          };
        }
        const checkpointId = String(args.checkpoint_id ?? args.id ?? '');
        const confirm = args.confirm === true;
        const output = rollbackWorkspaceCheckpoint(workspaceRoot, cqrRoot, checkpointId, {
          sessionKey: ctx?.sessionId ?? 'default',
          confirm,
          guard,
        });
        return { label: `rollback ${checkpointId}`, output };
      }
      case 'git_status': {
        const output = gitStatus(workspaceRoot);
        return { label: 'git status', output };
      }
      case 'git_init': {
        const output = gitInit(workspaceRoot, args.confirm === true);
        return { label: 'git init', output };
      }
      case 'git_sync_preview': {
        const fetch = args.fetch === false ? false : true;
        const remote = typeof args.remote === 'string' ? args.remote : undefined;
        const output = gitSyncPreview(workspaceRoot, { fetch, remote });
        return { label: 'git sync preview', output };
      }
      case 'git_diff': {
        const rel = typeof args.path === 'string' ? args.path : undefined;
        const staged = args.staged === true;
        const range = typeof args.range === 'string' ? args.range : undefined;
        const output = gitDiff(workspaceRoot, rel, staged, range);
        return {
          label: range ? `git diff ${range}` : rel ? `git diff ${rel}` : 'git diff',
          output,
        };
      }
      case 'git_log': {
        const range = typeof args.range === 'string' ? args.range : undefined;
        const max = typeof args.max === 'number' ? args.max : undefined;
        const output = gitLog(workspaceRoot, { range, max });
        return { label: range ? `git log ${range}` : 'git log', output };
      }
      case 'remote_git_inspect': {
        const action =
          typeof args.action === 'string' ? args.action : undefined;
        const repo = typeof args.repo === 'string' ? args.repo : undefined;
        const url = typeof args.url === 'string' ? args.url : undefined;
        const max = typeof args.max === 'number' ? args.max : undefined;
        const output = remoteGitInspect(workspaceRoot, {
          action: action as 'ensure_full' | 'unshallow' | 'log' | 'count' | 'status' | undefined,
          repo,
          url,
          max,
        });
        return { label: `remote_git_inspect ${action || 'ensure_full'}`, output };
      }
      case 'repomix_pack': {
        const extra = Array.isArray(args.args) ? args.args.map(String) : undefined;
        const result = runRepomixSidecar({ workspaceRoot, args: extra });
        return { label: 'repomix_pack', output: JSON.stringify(result, null, 2) };
      }
      case 'ast_grep_search': {
        const pattern = String(args.pattern ?? '').trim();
        if (!pattern) {
          return {
            label: 'ast_grep_search',
            output: JSON.stringify({ ok: false, error: 'pattern required' }),
          };
        }
        const lang = typeof args.lang === 'string' ? args.lang : undefined;
        const result = runAstGrepSidecar({ workspaceRoot, pattern, lang });
        return { label: 'ast_grep_search', output: JSON.stringify(result, null, 2) };
      }
      case 'markitdown_convert': {
        const rel = String(args.path ?? '').trim();
        if (!rel) {
          return {
            label: 'markitdown_convert',
            output: JSON.stringify({ ok: false, error: 'path required' }),
          };
        }
        const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
        if (!existsSync(abs)) {
          return {
            label: 'markitdown_convert',
            output: JSON.stringify({ ok: false, error: 'FILE_NOT_FOUND', path: abs }),
          };
        }
        const result = runMarkitdownSidecar({ filePath: abs });
        return { label: 'markitdown_convert', output: JSON.stringify(result, null, 2) };
      }
      case 'git_history_tree': {
        const max = typeof args.max === 'number' ? args.max : undefined;
        const all = args.all === true;
        const first_parent = args.first_parent === true;
        const pathArg = typeof args.path === 'string' ? args.path : undefined;
        const range = typeof args.range === 'string' ? args.range : undefined;
        const output = gitHistoryTree(workspaceRoot, {
          max,
          all,
          first_parent,
          path: pathArg,
          range,
        });
        return { label: 'git history tree', output };
      }
      case 'git_show': {
        const ref = typeof args.ref === 'string' ? args.ref : undefined;
        const pathArg = typeof args.path === 'string' ? args.path : undefined;
        const stat_only = args.stat_only === true;
        const output = gitShow(workspaceRoot, { ref, path: pathArg, stat_only });
        return { label: `git show ${ref ?? 'HEAD'}`, output };
      }
      case 'git_blame': {
        const pathArg = String(args.path ?? '');
        const max = typeof args.max === 'number' ? args.max : undefined;
        const output = gitBlame(workspaceRoot, pathArg, { max });
        return { label: `git blame ${pathArg}`, output };
      }
      case 'git_branch': {
        const action = typeof args.action === 'string' ? (args.action as 'list' | 'create') : undefined;
        const name = typeof args.name === 'string' ? args.name : undefined;
        const all = args.all === true;
        const confirm = args.confirm === true;
        const output = gitBranch(workspaceRoot, { action, name, all, confirm });
        return { label: action === 'create' ? 'git branch create' : 'git branch', output };
      }
      case 'git_switch': {
        const branch = String(args.branch ?? '');
        const confirm = args.confirm === true;
        const create = args.create === true;
        const force_dirty = args.force_dirty === true;
        const output = gitSwitch(workspaceRoot, { branch, confirm, create, force_dirty });
        return { label: `git switch ${branch}`, output };
      }
      case 'git_stage': {
        const paths = Array.isArray(args.paths) ? args.paths.map((p) => String(p)) : undefined;
        const all_tracked = args.all_tracked === true;
        const unstage = args.unstage === true;
        const output = gitStage(workspaceRoot, { paths, all_tracked, unstage });
        return { label: unstage ? 'git unstage' : 'git stage', output };
      }
      case 'git_restore': {
        const paths = Array.isArray(args.paths) ? args.paths.map((p) => String(p)) : [];
        const mode =
          args.mode === 'staged' || args.mode === 'both' || args.mode === 'worktree'
            ? args.mode
            : 'worktree';
        const confirm = args.confirm === true;
        const output = gitRestore(workspaceRoot, { paths, mode, confirm });
        return { label: 'git restore', output };
      }
      case 'git_stash': {
        const action =
          args.action === 'push' || args.action === 'pop' || args.action === 'drop' || args.action === 'list'
            ? args.action
            : 'list';
        const message = typeof args.message === 'string' ? args.message : undefined;
        const confirm = args.confirm === true;
        const index = typeof args.index === 'number' ? args.index : undefined;
        const output = gitStash(workspaceRoot, { action, message, confirm, index });
        return { label: `git stash ${action}`, output };
      }
      case 'git_fetch': {
        const remote = typeof args.remote === 'string' ? args.remote : undefined;
        const prune = args.prune === true;
        const unshallow = args.unshallow === true;
        const repo = typeof args.repo === 'string' ? args.repo : undefined;
        const output = gitFetch(workspaceRoot, { remote, prune, unshallow, repo });
        return { label: unshallow ? 'git fetch --unshallow' : 'git fetch', output };
      }
      case 'git_pull': {
        const confirm = args.confirm === true;
        const remote = typeof args.remote === 'string' ? args.remote : undefined;
        const branch = typeof args.branch === 'string' ? args.branch : undefined;
        const output = gitPull(workspaceRoot, { confirm, remote, branch });
        return { label: 'git pull', output };
      }
      case 'git_push': {
        const confirm = args.confirm === true;
        const remote = typeof args.remote === 'string' ? args.remote : undefined;
        const branch = typeof args.branch === 'string' ? args.branch : undefined;
        const set_upstream = args.set_upstream === true;
        const output = gitPush(workspaceRoot, { confirm, remote, branch, set_upstream });
        return { label: 'git push', output };
      }
      case 'git_commit': {
        const message = String(args.message ?? '');
        const confirm = args.confirm === true;
        const paths = Array.isArray(args.paths)
          ? args.paths.map((p) => String(p))
          : undefined;
        const output = gitCommit(workspaceRoot, message, { confirm, paths });
        return { label: 'git commit', output };
      }
      case 'plugin_list': {
        const cqrRoot = ctx?.cqrRoot;
        if (!cqrRoot) {
          return {
            label: 'plugin_list',
            output: JSON.stringify({ ok: false, error: 'cqrRoot missing' }, null, 2),
          };
        }
        return { label: 'plugin list', output: formatPluginListJson(cqrRoot) };
      }
      case 'plugin_scaffold': {
        const id = typeof args.id === 'string' ? args.id : undefined;
        const purpose = typeof args.purpose === 'string' ? args.purpose : undefined;
        const risk =
          args.risk === 'write' || args.risk === 'network' || args.risk === 'read'
            ? args.risk
            : undefined;
        return {
          label: 'plugin scaffold',
          output: scaffoldAgentPlugin({ id, purpose, risk }),
        };
      }
      case 'plugin_install': {
        const cqrRoot = ctx?.cqrRoot;
        if (!cqrRoot) {
          return {
            label: 'plugin_install',
            output: JSON.stringify({ ok: false, error: 'cqrRoot missing' }, null, 2),
          };
        }
        const template_id = typeof args.template_id === 'string' ? args.template_id : undefined;
        if (template_id) {
          const output = installAgentPluginFromTemplate(cqrRoot, {
            template_id,
            id: typeof args.id === 'string' ? args.id : undefined,
            confirm: args.confirm === true,
          });
          return { label: 'plugin install', output };
        }
        const toolJson =
          typeof args.tool_json === 'string'
            ? args.tool_json
            : args.tool_json && typeof args.tool_json === 'object'
              ? (args.tool_json as Record<string, unknown>)
              : undefined;
        const output = installAgentPlugin(cqrRoot, {
          id: String(args.id ?? ''),
          confirm: args.confirm === true,
          tool_json: toolJson,
          run_source: typeof args.run_source === 'string' ? args.run_source : '',
          created_by: 'agent',
        });
        return { label: 'plugin install', output };
      }
      case 'plugin_set_enabled': {
        const cqrRoot = ctx?.cqrRoot;
        if (!cqrRoot) {
          return {
            label: 'plugin_set_enabled',
            output: JSON.stringify({ ok: false, error: 'cqrRoot missing' }, null, 2),
          };
        }
        const output = setAgentPluginEnabled(cqrRoot, {
          id: String(args.id ?? ''),
          enabled: args.enabled === true,
          confirm: args.confirm === true,
        });
        return { label: 'plugin set_enabled', output };
      }
      case 'save_web_asset': {
        const cqrRoot = ctx?.cqrRoot;
        const sessionId = ctx?.sessionId;
        if (!cqrRoot || !sessionId) {
          return {
            label: 'save_web_asset',
            output: JSON.stringify({ ok: false, error: 'session context missing' }, null, 2),
          };
        }
        const result = await saveWebAsset({
          cqrRoot,
          sessionId,
          sourceUrl: String(args.url ?? ''),
          filename: typeof args.filename === 'string' ? args.filename : undefined,
          allowLocalhost: ctx.allowLocalhost === true,
        });
        return { label: `save_web_asset ${result.url ?? result.error ?? ''}`, output: JSON.stringify(result, null, 2) };
      }
      case 'browser_navigate': {
        const session = ctx?.browserSession;
        if (!session) {
          return {
            label: 'browser_navigate',
            output: 'ERROR: Playwright browser session is not open. Restart MY Agent after: powershell tools\\bootstrap-playwright-if-needed.ps1',
          };
        }
        const url = String(args.url ?? '');
        if (isPlaceholderNavUrl(url)) {
          return {
            label: `navigate ${url}`,
            output:
              'ERROR: Placeholder URL blocked (대상-주소 / example.com). Navigate only to local HTTP or a real production URL.',
          };
        }
        const nav = await session.navigate(url);
        return {
          label: `navigate ${url}`,
          output: JSON.stringify(nav, null, 2),
        };
      }
      case 'browser_screenshot': {
        const session = ctx?.browserSession;
        if (!session) {
          return {
            label: 'browser_screenshot',
            output: 'ERROR: Playwright is not available. Run: powershell -NoProfile -ExecutionPolicy Bypass -File tools\\bootstrap-playwright-if-needed.ps1',
          };
        }
        const rel = typeof args.path === 'string' ? args.path : undefined;
        const shot = await session.screenshot(workspaceRoot, rel, ctx?.sessionId, guard);
        return {
          label: `screenshot ${shot.relative}`,
          output: JSON.stringify(shot, null, 2),
        };
      }
      case 'browser_click': {
        const session = ctx?.browserSession;
        if (!session) {
          return {
            label: 'browser_click',
            output: 'ERROR: Playwright is not available. Run: powershell -NoProfile -ExecutionPolicy Bypass -File tools\\bootstrap-playwright-if-needed.ps1',
          };
        }
        const selector = String(args.selector ?? '');
        const msg = await session.click(selector);
        return { label: `click ${selector}`, output: msg };
      }
      case 'browser_fill': {
        const session = ctx?.browserSession;
        if (!session) {
          return {
            label: 'browser_fill',
            output: 'ERROR: Playwright is not available. Run: powershell -NoProfile -ExecutionPolicy Bypass -File tools\\bootstrap-playwright-if-needed.ps1',
          };
        }
        const selector = String(args.selector ?? '');
        const value = String(args.value ?? '');
        const msg = await session.fill(selector, value);
        return { label: `fill ${selector}`, output: msg };
      }
      case 'browser_evaluate': {
        const session = ctx?.browserSession;
        if (!session) {
          return {
            label: 'browser_evaluate',
            output: 'ERROR: Playwright is not available. Run: powershell -NoProfile -ExecutionPolicy Bypass -File tools\\bootstrap-playwright-if-needed.ps1',
          };
        }
        const expression = String(args.expression ?? '');
        const result = await session.evaluate(expression);
        return { label: 'evaluate', output: result };
      }
      default: {
        if (name.startsWith('mcp_') && ctx?.cqrRoot) {
          const output = await callUserMcpTool(
            ctx.cqrRoot,
            name,
            args as Record<string, unknown>,
          );
          return { label: name, output };
        }
        if (name.startsWith('plugin_') && ctx?.cqrRoot) {
          const rec = getAgentPluginByToolName(ctx.cqrRoot, name);
          if (rec) {
            const confirm = args.confirm === true;
            const output = runAgentPlugin(
              ctx.cqrRoot,
              workspaceRoot,
              rec,
              args as Record<string, unknown>,
              { confirm },
            );
            return { label: name, output };
          }
        }
        const available = availableToolNames(ctx?.cqrRoot);
        const raw = [
          `Unknown tool: ${call.function.name}`,
          `Available tools: ${available.join(', ')}`,
        ].join('\n');
        return {
          label: name,
          output: formatToolSelfCorrection(call.function.name, raw, available),
        };
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const permission = normalizeWindowsPermissionError(e);
    const available = availableToolNames(ctx?.cqrRoot);
    return {
      label: name,
      output: formatToolSelfCorrection(
        name,
        permission ? `ERROR: ${permission.code}\n${permission.message}` : `ERROR: ${msg}`,
        available,
      ),
    };
  }
}

