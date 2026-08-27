import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { assertPathUnder } from '../security/path-guard.js';
import { SecurityError } from '../security/errors.js';
import { assertDevWorkspaceRoot } from '../security/dev-workspace-guard.js';
import { probeWorkspaceCapabilities } from '../security/workspace-capabilities.js';
import { hasNasWriteConsent, buildNasWriteConsent } from '../security/nas-write-consent.js';
import { browseDirectories, buildWorkspaceUiTree, readWorkspaceFile, writeWorkspaceFile } from '../agent/dev-workspace-fs.js';
import {
  cancelTerminalJob,
  listActiveTerminalJobIds,
  listActiveTerminalJobs,
  runTerminalCommand,
  runTerminalCommandAsync,
} from '../agent/run-terminal.js';
import { rollbackWorkspaceCheckpoint, previewCheckpointDiff } from '../agent/agent-checkpoint.js';
import {
  formatUserMcpServersJson,
  loadUserMcpConfig,
  probeUserMcpServer,
  saveUserMcpConfig,
  type UserMcpServerConfig,
} from '../agent/user-mcp.js';
import { loadUserOverrides, saveUserOverrides, isProviderAllowedLocalOnly } from '../config/user-overrides.js';
import { loadDeployDefaults } from '../config/deploy-defaults.js';
import { testOllamaReachable } from '../inference/local-llama-runtime.js';
import type { ModelKind } from '../models/types.js';
import { buildModelPicker, invalidateRemoteModelCache } from '../models/model-picker.js';
import { testConnection, testNativeToolConnection, listRemoteModels } from '../providers/openai-compatible.js';
import { curateRemoteModels, resolveDefaultOwuiModel } from '../providers/remote-model-curate.js';
import { ProviderError } from '../providers/types.js';
import type { ProviderWireApi } from '../providers/types.js';
import {
  requiresNativeTools,
  selectWireApiAtConfiguration,
  wireApiLabel,
} from '../providers/provider-wire-api.js';
import { quickVerifyGguf, deepVerifyWithServer } from '../inference/llama-backend.js';
import { probePlaywright } from '../browser/playwright-probe.js';
import { browserNavigateViaMcp, browserScreenshotViaMcp, getPlaywrightMcpDiagnostics } from '../browser/playwright-mcp-bridge.js';
import { parseChatRequest } from '../chat/chat-orchestrator.js';
import { resolveWorkspaceRootForSession } from '../chat/session-context.js';
import { clientAbortSignal } from '../chat/abort.js';
import { ProjectStoreError } from '../projects/project-store.js';
import { parseMultipart } from '../attachments/multipart.js';
import { getErrorReportPublicConfig, sendErrorReportNow } from '../support/error-report-service.js';
import type { ErrorReportSettings } from '../config/user-overrides.js';
import { computeMachineId } from '../license/machine-id.js';
import {
  listAllSkills,
  isBundledSkillId,
  getSkillSystemPromptByMode,
} from '../skills/skill-registry.js';
import { getOrganizationSkillDef } from '../skills/organization-skill-store.js';
import { UserSkillError } from '../skills/user-skill-store.js';
import {
  describeOrganizationModuleStatus,
  installOrganizationModule,
  OrganizationModuleError,
} from '../updates/organization-module-installer.js';
import {
  applyOrganizationModuleUpdate,
  checkOrganizationModuleUpdate,
} from '../updates/organization-module-feed.js';
import {
  installAgentPlugin,
  installAgentPluginFromTemplate,
  listAgentPlugins,
  listPluginTemplates,
  purgeLabSmokePlugins,
  setAgentPluginEnabled,
  uninstallAgentPlugin,
  isLabSmokePluginId,
  ensureShippedProductPlugins,
} from '../agent/agent-plugin-store.js';
import { getAutomatonDiagnostics } from '../automaton/adapter.js';
import { collectLlmRuntimeStatus, compactLlmRuntimeStatus } from '../runtime/llm-runtime-status.js';
import type { ApiContext } from '../http/api-context.js';
import { listContextLimitMismatches } from '../providers/model-context-limits.js';
import { listRecentSoftCostWarns } from '../agent/agent-perf-metrics.js';
import { softRpmLimit, softStepLatencyWarnMs } from '../providers/harness-policy.js';
import { sendJson, readBody, sessionFromReq } from '../http/json.js';
import { publicAttachment } from '../http/attachment-dto.js';
import { resolveToolApproval } from '../agent/tool-approval.js';
import { summarizeAgentAuditLedger, formatAuditSummaryBrief } from '../agent/agent-audit-ledger.js';
import {
  defaultExecutionPolicyFromConfig,
  normalizeExecutionPolicy,
  type ReasoningLevel,
} from '../execution-policy.js';

const UI_ASSET_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function sendUiAsset(res: ServerResponse, filePath: string): void {
  const ext = path.extname(filePath);
  res.writeHead(200, {
    'Content-Type': UI_ASSET_TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control':
      ext === '.css' || ext === '.js' || ext === '.html'
        ? 'no-store, no-cache, must-revalidate'
        : 'no-cache',
  });
  res.end(readFileSync(filePath));
}

function sendWorkspaceIndex(res: ServerResponse, workspaceUiDir: string, appVersion: string): void {
  const indexPath = path.join(workspaceUiDir, 'index.html');
  let assetV = appVersion;
  try {
    assetV = `${appVersion}-${statSync(indexPath).mtimeMs}`;
  } catch {
    /* ignore */
  }
  const html = readFileSync(indexPath, 'utf8')
    .replace(/(src|href)="(\/assets\/[^"]+)"/g, `$1="$2?v=${encodeURIComponent(assetV)}"`);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  });
  res.end(html);
}

function looksLikeApiPath(pathname: string): boolean {
  const roots = [
    '/chat',
    '/sessions',
    '/models',
    '/license',
    '/config',
    '/providers',
    '/attachments',
    '/skills',
    '/agent-plugins',
    '/mcp',
    '/generate',
    '/outputs',
    '/admin',
    '/health',
    '/fs',
    '/setup',
    '/browser',
    '/automaton',
    '/projects',
    '/workspace',
    '/error-report',
    '/organization-module',
    '/assets/',
  ];
  return roots.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(p));
}

function isRemovedUiPath(pathname: string): boolean {
  return pathname === '/legacy'
    || pathname.startsWith('/legacy/')
    || pathname === '/ui'
    || pathname.startsWith('/ui/');
}

export async function dispatchApiRequest(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<void> {
  const {
    cqrRoot,
    paths,
    port,
    appVersion,
    workspaceUiDir,
    userConfigPath,
    license,
    getOverrides,
    attachments,
    modelRegistry,
    modelUpload,
    providerStore,
    projectStore,
    userSkillStore,
    sessionStore,
    setup,
    llamaBinary,
    imageOut,
    orchestrator,
  } = ctx;

  const workspaceRootForRequest = (): string | null => {
    const sessionId = sessionFromReq(req);
    if (sessionId) {
      const session = sessionStore.load(sessionId);
      const sessionRoot = resolveWorkspaceRootForSession(sessionStore, projectStore, sessionId);
      if (sessionRoot) return sessionRoot;
      // A project-bound chat must opt in to a registered work folder. Do not
      // silently inherit the PC-wide active folder.
      if (session?.project_id) return null;
    }
    return loadUserOverrides(userConfigPath).dev_workspace_root?.trim() || null;
  };

      if (method === 'GET' && url.pathname === '/health') {
        let distMtimeMs = 0;
        try {
          distMtimeMs = statSync(path.join(cqrRoot, 'core', 'dist', 'main.js')).mtimeMs;
        } catch {
          /* ignore */
        }
        const llm = await collectLlmRuntimeStatus(providerStore, userConfigPath);
        const workspaceReady =
          Boolean(workspaceUiDir)
          && existsSync(path.join(workspaceUiDir, 'index.html'));
        return sendJson(res, 200, {
          ok: true,
          product: 'MY Agent',
          version: appVersion,
          cqr_root: cqrRoot,
          dist_mtime_ms: distMtimeMs,
          ui: 'workspace',
          ui_ready: workspaceReady,
          llm_runtime: compactLlmRuntimeStatus(llm),
        });
      }

      if (method === 'GET' && url.pathname === '/runtime/llm-status') {
        const fresh = url.searchParams.get('fresh') === '1';
        const llm = await collectLlmRuntimeStatus(providerStore, userConfigPath, { fresh });
        return sendJson(res, 200, llm);
      }

      if (method === 'GET' && url.pathname === '/license/status') {
        return sendJson(res, 200, license.getStatus());
      }

      if (method === 'GET' && url.pathname === '/license/features') {
        const s = license.getStatus();
        return sendJson(res, s.mode === 'full' ? 200 : 403, {
          features: s.features,
          mode: s.mode,
        });
      }

      if (method === 'GET' && url.pathname === '/admin/diagnostics') {
        const setupSt = setup.getStatus();
        const lic = license.getStatus();
        const logFiles: { name: string; size: number; mtime: string }[] = [];
        if (existsSync(paths.logsDir)) {
          for (const name of readdirSync(paths.logsDir)) {
            const fp = path.join(paths.logsDir, name);
            try {
              const st = statSync(fp);
              if (st.isFile()) {
                logFiles.push({ name, size: st.size, mtime: st.mtime.toISOString() });
              }
            } catch {
              /* skip */
            }
          }
          logFiles.sort((a, b) => b.mtime.localeCompare(a.mtime));
        }
        const nodeEmbedded = existsSync(path.join(cqrRoot, 'runtime', 'node', 'node.exe'));
        const configured = providerStore.getConfiguredIds();
        const automaton = await getAutomatonDiagnostics(loadDeployDefaults(cqrRoot).live_automaton_root);
        const playwright = probePlaywright(cqrRoot);
        const playwrightMcp = await getPlaywrightMcpDiagnostics(cqrRoot);
        const llmRuntime = await collectLlmRuntimeStatus(providerStore, userConfigPath, { fresh: true });
        const agentAudit = summarizeAgentAuditLedger(cqrRoot, { maxLines: 2000 });
        const modelIdsForMismatch: string[] = [];
        const runtimeModels = (llmRuntime as { models?: Array<{ id?: string }> })?.models;
        if (Array.isArray(runtimeModels)) {
          for (const m of runtimeModels) {
            if (m?.id) modelIdsForMismatch.push(String(m.id));
          }
        }
        const pickerDefault = (llmRuntime as { default_model?: string })?.default_model;
        if (pickerDefault) modelIdsForMismatch.push(String(pickerDefault));
        const contextMismatches = listContextLimitMismatches([...new Set(modelIdsForMismatch)].slice(0, 40));
        return sendJson(res, 200, {
          product: 'MY Agent',
          version: appVersion,
          cqr_root: cqrRoot,
          port,
          node_embedded: nodeEmbedded,
          llama_binary: llamaBinary,
          license: lic,
          setup: setupSt,
          config: getOverrides(),
          providers_configured: configured,
          automaton_mcp: automaton,
          playwright,
          playwright_mcp: playwrightMcp,
          llm_runtime: llmRuntime,
          context_budget: {
            soft_rpm: softRpmLimit(),
            soft_step_latency_ms: softStepLatencyWarnMs(),
            soft_cost_warns: listRecentSoftCostWarns(),
            context_limit_mismatches: contextMismatches,
          },
          agent_audit: {
            brief: formatAuditSummaryBrief(agentAudit),
            ...agentAudit,
          },
          deploy_parity: {
            ollama_configured: configured.includes('ollama'),
            all_skill_features: (
              [
                'web_dev',
                'browser_automation',
                'image_generation',
                'deep_research',
              ] as const
            ).every((f) => lic.features?.includes(f)),
            ready_for_full_features:
              lic.mode === 'full' &&
              configured.includes('ollama'),
          },
          logs: logFiles.slice(0, 20),
        });
      }

      if (method === 'GET' && url.pathname === '/config/error-report') {
        license.assertFeature('manager');
        return sendJson(res, 200, getErrorReportPublicConfig(cqrRoot, paths.dataDir, paths.vaultDir));
      }

      if (method === 'PUT' && url.pathname === '/config/error-report') {
        license.assertWritable();
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as ErrorReportSettings;
        const current = getOverrides();
        const nextReport: ErrorReportSettings = {
          ...(current.error_report ?? {}),
          enabled: body.enabled === true,
        };
        const next = saveUserOverrides(userConfigPath, { error_report: nextReport }, cqrRoot);
        return sendJson(res, 200, {
          ...getErrorReportPublicConfig(cqrRoot, paths.dataDir, paths.vaultDir),
          error_report: next.error_report,
        });
      }

      if (method === 'PUT' && url.pathname === '/error-report/preferences') {
        license.assertWritable();
        const body = JSON.parse(await readBody(req)) as { enabled?: boolean };
        const nextReport: ErrorReportSettings = {
          enabled: body.enabled === true,
        };
        saveUserOverrides(userConfigPath, { error_report: nextReport }, cqrRoot);
        return sendJson(res, 200, getErrorReportPublicConfig(cqrRoot, paths.dataDir, paths.vaultDir));
      }

      if (method === 'POST' && url.pathname === '/config/error-report/test') {
        license.assertWritable();
        license.assertFeature('manager');
        const result = await sendErrorReportNow(
          cqrRoot,
          paths.dataDir,
          paths.vaultDir,
          {
            subject: 'MY Agent 로컬 오류 기록 테스트',
            summary: '오류 보고 화면에서 생성한 로컬 기록 테스트입니다.',
            mode: 'test',
          },
          true,
        );
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === 'GET' && url.pathname === '/error-report/status') {
        const pub = getErrorReportPublicConfig(cqrRoot, paths.dataDir, paths.vaultDir);
        return sendJson(res, 200, pub);
      }

      if (method === 'POST' && url.pathname === '/error-report/send') {
        const body = JSON.parse(await readBody(req)) as { note?: string };
        const note = (body.note ?? '').trim();
        const result = await sendErrorReportNow(
          cqrRoot,
          paths.dataDir,
          paths.vaultDir,
          {
            subject: 'MY Agent 수동 오류 기록',
            summary: note || '사용자가 UI의 오류 기록 버튼으로 저장했습니다.',
            mode: 'manual',
          },
          true,
        );
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === 'GET' && url.pathname === '/config') {
        return sendJson(res, 200, getOverrides());
      }

      if (method === 'PUT' && url.pathname === '/config/local-only') {
        license.assertWritable();
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as { local_only?: boolean };
        const next = saveUserOverrides(userConfigPath, { local_only: body.local_only === true }, cqrRoot);
        return sendJson(res, 200, next);
      }

      if (method === 'PUT' && url.pathname === '/config/agent-autopilot') {
        license.assertWritable();
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as { agent_autopilot?: boolean | null };
        const agentAutopilot = body.agent_autopilot === true
          ? true
          : body.agent_autopilot === false ? false : null;
        const next = saveUserOverrides(
          userConfigPath,
          { agent_autopilot: agentAutopilot },
          cqrRoot,
        );
        return sendJson(res, 200, next);
      }

      if (method === 'PUT' && url.pathname === '/config/agent-execution-preset') {
        license.assertWritable();
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as { preset?: string };
        if (body.preset !== 'delegate') {
          return sendJson(res, 400, { error: 'INVALID_PRESET', message: '지원하지 않는 에이전트 실행 프리셋입니다.' });
        }
        const root = getOverrides().dev_workspace_root?.trim();
        if (!root) return sendJson(res, 409, { error: 'NO_WORKSPACE', message: '나 대신 진행을 사용하려면 작업 폴더를 먼저 선택하세요.' });
        const capabilities = probeWorkspaceCapabilities(root);
        if (capabilities.mode !== 'read_write') {
          return sendJson(res, 409, { error: 'WORKSPACE_NOT_WRITABLE', message: capabilities.issues[0]?.message ?? '작업 폴더에 쓰기 권한이 없습니다.', capabilities });
        }
        const next = saveUserOverrides(
          userConfigPath,
          { agent_autopilot: true, approval_delegation: 'auto_review' },
          cqrRoot,
        );
        return sendJson(res, 200, next);
      }

      if (method === 'PUT' && url.pathname === '/config/agent-reasoning') {
        license.assertWritable();
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as { agent_reasoning?: ReasoningLevel };
        const reasoning = normalizeExecutionPolicy({ reasoning: body.agent_reasoning }).reasoning;
        const next = saveUserOverrides(userConfigPath, { agent_reasoning: reasoning }, cqrRoot);
        return sendJson(res, 200, next);
      }

      if (method === 'PUT' && url.pathname === '/config/approval-delegation') {
        license.assertWritable();
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as { approval_delegation?: string };
        const mode = body.approval_delegation === 'auto_review'
          ? 'auto_review'
          : body.approval_delegation === 'safe_local' ? 'safe_local' : 'off';
        if (mode !== 'off') {
          const root = getOverrides().dev_workspace_root?.trim();
          if (!root) return sendJson(res, 409, { error: 'NO_WORKSPACE', message: '승인 위임 전에 작업 폴더를 선택하세요.' });
          const capabilities = probeWorkspaceCapabilities(root);
          if (capabilities.mode !== 'read_write') {
            return sendJson(res, 409, { error: 'WORKSPACE_NOT_WRITABLE', message: capabilities.issues[0]?.message ?? '작업 폴더에 쓰기 권한이 없습니다.', capabilities });
          }
        }
        const next = saveUserOverrides(userConfigPath, { approval_delegation: mode }, cqrRoot);
        return sendJson(res, 200, next);
      }

      if (method === 'GET' && url.pathname === '/config/workspace-capabilities') {
        const root = getOverrides().dev_workspace_root?.trim();
        if (!root) return sendJson(res, 200, { mode: 'restricted', readable: false, create_delete: false, issues: [{ code: 'NO_WORKSPACE', message: '작업 폴더를 먼저 선택하세요.' }] });
        return sendJson(res, 200, probeWorkspaceCapabilities(root));
      }

      if (method === 'PUT' && url.pathname === '/config/dev-workspace') {
        license.assertWritable();
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as { dev_workspace_root?: string };
        const root = (body.dev_workspace_root ?? '').trim();
        if (!root) {
          const next = saveUserOverrides(userConfigPath, { dev_workspace_root: undefined }, cqrRoot);
          return sendJson(res, 200, { ...next, active_workspace_project_id: null });
        }
        const overrides = getOverrides();
        const allowNas = hasNasWriteConsent(overrides);
        try {
          assertDevWorkspaceRoot(root, { allowNas });
        } catch (e: unknown) {
          if (e instanceof SecurityError && e.code === 'NAS_CONSENT_REQUIRED') {
            return sendJson(res, 403, { error: e.code, message: e.message });
          }
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'INVALID_DEV_WORKSPACE', message: msg });
        }
        const workspaceProject = projectStore.upsertWorkspaceRoot(root);
        const next = saveUserOverrides(userConfigPath, { dev_workspace_root: root }, cqrRoot);
        return sendJson(res, 200, {
          ...next,
          active_workspace_project_id: workspaceProject.id,
          workspace_root_project_id: workspaceProject.id,
        });
      }

      if (method === 'GET' && url.pathname === '/config/nas-consent') {
        const consent = getOverrides().nas_write_consent;
        return sendJson(res, 200, {
          enabled: consent?.enabled === true,
          approved_at: consent?.approved_at ?? null,
          approved_by: consent?.approved_by ?? null,
        });
      }

      if (method === 'PUT' && url.pathname === '/config/nas-consent') {
        license.assertWritable();
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as { enabled?: boolean };
        const enabled = body.enabled === true;
        const next = saveUserOverrides(
          userConfigPath,
          { nas_write_consent: buildNasWriteConsent(enabled) },
          cqrRoot,
        );
        const consent = next.nas_write_consent;
        return sendJson(res, 200, {
          enabled: consent?.enabled === true,
          approved_at: consent?.approved_at ?? null,
          approved_by: consent?.approved_by ?? null,
        });
      }

      if (method === 'GET' && url.pathname === '/fs/browse') {
        license.assertFeature('manager');
        const requested = url.searchParams.get('path') ?? undefined;
        try {
          const result = browseDirectories(requested);
          return sendJson(res, 200, result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'BROWSE_FAILED', message: msg });
        }
      }

      if (method === 'GET' && url.pathname === '/fs/workspace-tree') {
        license.assertFeature('chat');
        const overrides = loadUserOverrides(userConfigPath);
        const root = workspaceRootForRequest();
        if (!root) {
          return sendJson(res, 200, { root: null, tree: [], message: '작업 폴더가 설정되지 않았습니다.' });
        }
        try {
          const allowNas = hasNasWriteConsent(overrides);
          assertDevWorkspaceRoot(root, { allowNas });
          const depth = Math.min(5, Math.max(1, Number(url.searchParams.get('depth') ?? 3) || 3));
          const result = buildWorkspaceUiTree(root, '.', { maxDepth: depth, allowNas });
          return sendJson(res, 200, result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'TREE_FAILED', message: msg, root, tree: [] });
        }
      }

      if (method === 'POST' && url.pathname === '/fs/open-workspace-root') {
        license.assertFeature('chat');
        const overrides = loadUserOverrides(userConfigPath);
        const root = workspaceRootForRequest();
        if (!root) {
          return sendJson(res, 400, { error: 'NO_DEV_WORKSPACE', message: '작업 폴더를 먼저 연결하세요.' });
        }
        try {
          const allowNas = hasNasWriteConsent(overrides);
          assertDevWorkspaceRoot(root, { allowNas });
          if (!existsSync(root) || !statSync(root).isDirectory()) {
            return sendJson(res, 404, { error: 'WORKSPACE_NOT_FOUND', message: '연결된 작업 폴더를 찾을 수 없습니다.' });
          }
          const command = process.platform === 'win32'
            ? 'explorer.exe'
            : process.platform === 'darwin' ? 'open' : 'xdg-open';
          const child = spawn(command, [root], {
            detached: true,
            stdio: 'ignore',
          });
          await new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
          });
          child.unref();
          return sendJson(res, 200, { ok: true, root });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'OPEN_WORKSPACE_FAILED', message: msg });
        }
      }

      if (method === 'POST' && url.pathname === '/fs/open-workspace-path') {
        license.assertFeature('chat');
        let body: { path?: string };
        try {
          body = JSON.parse(await readBody(req)) as { path?: string };
        } catch {
          return sendJson(res, 400, { error: 'INVALID_JSON', message: 'JSON body required' });
        }
        const rel = String(body.path ?? '').trim();
        if (!rel) return sendJson(res, 400, { error: 'PATH_REQUIRED', message: '경로를 입력하세요.' });
        const overrides = loadUserOverrides(userConfigPath);
        const root = workspaceRootForRequest();
        if (!root) {
          return sendJson(res, 400, { error: 'NO_DEV_WORKSPACE', message: '작업 폴더를 먼저 연결하세요.' });
        }
        try {
          const allowNas = hasNasWriteConsent(overrides);
          assertDevWorkspaceRoot(root, { allowNas });
          const target = path.resolve(root, rel);
          assertPathUnder(root, target);
          if (!existsSync(target)) {
            return sendJson(res, 404, { error: 'WORKSPACE_PATH_NOT_FOUND', message: '작업 경로를 찾을 수 없습니다.' });
          }
          const targetIsDirectory = statSync(target).isDirectory();
          const command = process.platform === 'win32'
            ? 'explorer.exe'
            : process.platform === 'darwin' ? 'open' : 'xdg-open';
          const args = process.platform === 'win32' && !targetIsDirectory
            ? [`/select,${target}`]
            : [target];
          const child = spawn(command, args, {
            detached: true,
            stdio: 'ignore',
          });
          await new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
          });
          child.unref();
          return sendJson(res, 200, { ok: true, path: rel });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'OPEN_WORKSPACE_PATH_FAILED', message: msg });
        }
      }

      if (method === 'GET' && url.pathname === '/fs/workspace-file') {
        license.assertFeature('chat');
        const rel = (url.searchParams.get('path') ?? '').trim();
        if (!rel) return sendJson(res, 400, { error: 'PATH_REQUIRED' });
        const overrides = loadUserOverrides(userConfigPath);
        const root = workspaceRootForRequest();
        if (!root) {
          return sendJson(res, 400, { error: 'NO_DEV_WORKSPACE', message: '작업 폴더를 먼저 연결하세요.' });
        }
        try {
          const allowNas = hasNasWriteConsent(overrides);
          assertDevWorkspaceRoot(root, { allowNas });
          const content = readWorkspaceFile(root, rel, { allowNas });
          return sendJson(res, 200, { path: rel, content });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'READ_FAILED', message: msg });
        }
      }

      if (method === 'PUT' && url.pathname === '/fs/workspace-file') {
        license.assertWritable();
        license.assertFeature('chat');
        let body: { path?: string; content?: string };
        try {
          body = JSON.parse(await readBody(req)) as { path?: string; content?: string };
        } catch {
          return sendJson(res, 400, { error: 'INVALID_JSON', message: 'JSON body required' });
        }
        const rel = String(body.path ?? '').trim();
        if (!rel) return sendJson(res, 400, { error: 'PATH_REQUIRED' });
        if (typeof body.content !== 'string') {
          return sendJson(res, 400, { error: 'CONTENT_REQUIRED', message: 'content must be a string' });
        }
        const overrides = loadUserOverrides(userConfigPath);
        const root = workspaceRootForRequest();
        if (!root) {
          return sendJson(res, 400, { error: 'NO_DEV_WORKSPACE', message: '작업 폴더를 먼저 연결하세요.' });
        }
        try {
          const allowNas = hasNasWriteConsent(overrides);
          assertDevWorkspaceRoot(root, { allowNas });
          writeWorkspaceFile(root, rel, body.content, { allowNas });
          return sendJson(res, 200, { ok: true, path: rel });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'WRITE_FAILED', message: msg });
        }
      }

      if (method === 'POST' && url.pathname === '/fs/workspace-file/rename') {
        license.assertWritable();
        license.assertFeature('chat');
        let body: { path?: string; name?: string };
        try {
          body = JSON.parse(await readBody(req)) as { path?: string; name?: string };
        } catch {
          return sendJson(res, 400, { error: 'INVALID_JSON', message: 'JSON body required' });
        }
        const rel = String(body.path ?? '').trim();
        const name = String(body.name ?? '').trim();
        if (!rel) return sendJson(res, 400, { error: 'PATH_REQUIRED' });
        if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
          return sendJson(res, 400, { error: 'INVALID_NAME', message: '파일명만 입력하세요.' });
        }
        const overrides = loadUserOverrides(userConfigPath);
        const root = workspaceRootForRequest();
        if (!root) {
          return sendJson(res, 400, { error: 'NO_DEV_WORKSPACE', message: '작업 폴더를 먼저 연결하세요.' });
        }
        try {
          const allowNas = hasNasWriteConsent(overrides);
          assertDevWorkspaceRoot(root, { allowNas });
          const source = path.resolve(root, rel);
          const target = path.resolve(path.dirname(source), name);
          assertPathUnder(root, source);
          assertPathUnder(root, target);
          if (!existsSync(source) || !statSync(source).isFile()) {
            return sendJson(res, 404, { error: 'NOT_FOUND', message: '파일을 찾을 수 없습니다.' });
          }
          if (existsSync(target)) {
            return sendJson(res, 409, { error: 'TARGET_EXISTS', message: '같은 이름의 파일이 이미 있습니다.' });
          }
          renameSync(source, target);
          const nextPath = path.relative(root, target).split(path.sep).join('/');
          return sendJson(res, 200, { ok: true, path: nextPath });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'RENAME_FAILED', message: msg });
        }
      }

      if (method === 'POST' && url.pathname === '/fs/run-terminal') {
        license.assertFeature('chat');
        const overrides = loadUserOverrides(userConfigPath);
        const root = workspaceRootForRequest();
        if (!root) {
          return sendJson(res, 400, { error: 'NO_DEV_WORKSPACE', message: '작업 폴더를 먼저 연결하세요.' });
        }
        let body: {
          command?: string;
          timeout_ms?: number;
          async?: boolean;
          job_id?: string;
        };
        try {
          body = JSON.parse(await readBody(req)) as {
            command?: string;
            timeout_ms?: number;
            async?: boolean;
            job_id?: string;
          };
        } catch {
          return sendJson(res, 400, { error: 'INVALID_JSON', message: 'JSON body required' });
        }
        const command = String(body.command ?? '').trim();
        if (!command) {
          return sendJson(res, 400, { error: 'COMMAND_REQUIRED', message: 'command is required' });
        }
        try {
          const allowNas = hasNasWriteConsent(overrides);
          assertDevWorkspaceRoot(root, { allowNas });
          const timeoutMs = Math.min(
            180_000,
            Math.max(1_000, Number(body.timeout_ms ?? 60_000) || 60_000),
          );
          if (body.async === true) {
            const jobId =
              String(body.job_id ?? '').trim()
              || `ui_${sessionFromReq(req) || 'default'}_${Date.now()}`;
            const signal = req.aborted
              ? AbortSignal.abort()
              : undefined;
            // Client disconnect does not always abort long PowerShell — UI should POST cancel.
            const result = await runTerminalCommandAsync(root, command, {
              timeoutMs,
              jobId,
              signal,
            });
            return sendJson(res, 200, { ...result, job_id: jobId });
          }
          const result = runTerminalCommand(root, command, { timeoutMs });
          return sendJson(res, 200, result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'TERMINAL_FAILED', message: msg });
        }
      }

      if (method === 'POST' && url.pathname === '/fs/run-terminal/cancel') {
        license.assertFeature('chat');
        let body: { job_id?: string; session_id?: string };
        try {
          body = JSON.parse(await readBody(req)) as { job_id?: string; session_id?: string };
        } catch {
          return sendJson(res, 400, { error: 'INVALID_JSON', message: 'JSON body required' });
        }
        const jobId = String(body.job_id ?? '').trim();
        const sessionId = String(body.session_id ?? '').trim();
        let cancelled = false;
        if (jobId) cancelled = cancelTerminalJob(jobId) || cancelled;
        if (sessionId) cancelled = cancelTerminalJob(`agent_${sessionId}`) || cancelled;
        return sendJson(res, 200, {
          ok: true,
          cancelled,
          active: listActiveTerminalJobIds(),
          jobs: listActiveTerminalJobs(),
        });
      }

      if (method === 'GET' && url.pathname === '/fs/run-terminal/jobs') {
        license.assertFeature('chat');
        return sendJson(res, 200, {
          ok: true,
          active: listActiveTerminalJobIds(),
          jobs: listActiveTerminalJobs(),
        });
      }

      if (method === 'POST' && url.pathname === '/workspace/checkpoint/rollback') {
        license.assertWritable();
        license.assertFeature('chat');
        const overrides = loadUserOverrides(userConfigPath);
        const root = workspaceRootForRequest();
        if (!root) {
          return sendJson(res, 400, { error: 'NO_DEV_WORKSPACE', message: '작업 폴더를 먼저 연결하세요.' });
        }
        let body: {
          checkpoint_id?: string;
          confirm?: boolean;
          session_id?: string;
          paths?: string[];
        };
        try {
          body = JSON.parse(await readBody(req)) as {
            checkpoint_id?: string;
            confirm?: boolean;
            session_id?: string;
            paths?: string[];
          };
        } catch {
          return sendJson(res, 400, { error: 'INVALID_JSON', message: 'JSON body required' });
        }
        const checkpointId = String(body.checkpoint_id ?? '').trim();
        if (!checkpointId) {
          return sendJson(res, 400, { error: 'CHECKPOINT_REQUIRED', message: 'checkpoint_id required' });
        }
        try {
          const allowNas = hasNasWriteConsent(overrides);
          assertDevWorkspaceRoot(root, { allowNas });
          const raw = rollbackWorkspaceCheckpoint(root, cqrRoot, checkpointId, {
            sessionKey: String(body.session_id ?? sessionFromReq(req) ?? 'default').trim() || 'default',
            confirm: body.confirm === true,
            guard: { allowNas },
            paths: Array.isArray(body.paths) ? body.paths.map(String) : undefined,
          });
          const doc = JSON.parse(raw) as { ok?: boolean };
          return sendJson(res, doc.ok ? 200 : 400, JSON.parse(raw));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'ROLLBACK_FAILED', message: msg });
        }
      }

      if (method === 'GET' && url.pathname === '/workspace/checkpoint/preview') {
        license.assertFeature('chat');
        const overrides = loadUserOverrides(userConfigPath);
        const root = workspaceRootForRequest();
        if (!root) {
          return sendJson(res, 400, { error: 'NO_DEV_WORKSPACE', message: '작업 폴더를 먼저 연결하세요.' });
        }
        const checkpointId = String(url.searchParams.get('checkpoint_id') ?? '').trim();
        const rel = String(url.searchParams.get('path') ?? '').trim();
        const sessionId = String(
          url.searchParams.get('session_id') ?? sessionFromReq(req) ?? 'default',
        ).trim() || 'default';
        if (!checkpointId || !rel) {
          return sendJson(res, 400, {
            error: 'ARGS_REQUIRED',
            message: 'checkpoint_id and path query required',
          });
        }
        try {
          const allowNas = hasNasWriteConsent(overrides);
          assertDevWorkspaceRoot(root, { allowNas });
          const raw = previewCheckpointDiff(root, cqrRoot, checkpointId, rel, {
            sessionKey: sessionId,
            guard: { allowNas },
          });
          const doc = JSON.parse(raw) as { ok?: boolean };
          return sendJson(res, doc.ok ? 200 : 400, JSON.parse(raw));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(res, 400, { error: 'PREVIEW_FAILED', message: msg });
        }
      }

      // --- User MCP servers (remote Streamable HTTP; data/config/user-mcp-servers.json) ---
      if (method === 'GET' && url.pathname === '/mcp/servers') {
        license.assertFeature('chat');
        return sendJson(res, 200, JSON.parse(formatUserMcpServersJson(cqrRoot)));
      }

      if (method === 'PUT' && url.pathname === '/mcp/servers') {
        license.assertWritable();
        license.assertFeature('chat');
        let body: { servers?: UserMcpServerConfig[] };
        try {
          body = JSON.parse(await readBody(req)) as { servers?: UserMcpServerConfig[] };
        } catch {
          return sendJson(res, 400, { error: 'INVALID_JSON', message: 'JSON body required' });
        }
        const servers = Array.isArray(body.servers) ? body.servers : null;
        if (!servers) {
          return sendJson(res, 400, { error: 'SERVERS_REQUIRED', message: 'servers array required' });
        }
        const prev = loadUserMcpConfig(cqrRoot);
        const mergedServers = servers.map((server) => {
          const previous = prev.servers.find((item) => item.id === server.id);
          return {
            ...server,
            authToken: server.authToken?.trim() || previous?.authToken,
          };
        });
        saveUserMcpConfig(cqrRoot, { version: 3, servers: mergedServers });
        return sendJson(res, 200, {
          ok: true,
          before: prev.servers.length,
          after: servers.length,
          path: 'data/config/user-mcp-servers.json',
        });
      }

      if (method === 'POST' && url.pathname === '/mcp/servers/test') {
        license.assertFeature('chat');
        let body: { id?: string };
        try {
          body = JSON.parse(await readBody(req)) as { id?: string };
        } catch {
          return sendJson(res, 400, { error: 'INVALID_JSON', message: 'JSON body required' });
        }
        const result = await probeUserMcpServer(cqrRoot, String(body.id ?? ''));
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === 'GET' && url.pathname === '/setup/status') {
        return sendJson(res, 200, setup.getStatus());
      }

      if (method === 'GET' && url.pathname === '/setup/machine-id') {
        const st = setup.getStatus();
        return sendJson(res, 200, {
          windows_user: st.windows_user,
          machine_id: computeMachineId(cqrRoot),
        });
      }

      if (method === 'GET' && url.pathname === '/setup/windows-user') {
        const st = setup.getStatus();
        return sendJson(res, 200, { windows_user: st.windows_user });
      }

      if (method === 'POST' && url.pathname === '/setup/activate') {
        const result = await setup.tryCentralActivation();
        license.reload();
        setup.syncProviderRegistry();
        await setup.ensureOpenClawAdapter();
        const st = setup.getStatus();
        if (!result.license && st.needs_license) {
          return sendJson(res, 502, {
            error: 'ACTIVATION_FAILED',
            message: st.activation_error ?? '사내 활성화 서버에서 라이선스를 받지 못했습니다.',
            activation_server_url: st.activation_server_url,
          });
        }
        return sendJson(res, 200, { ok: true, ...result, status: st });
      }

      if (method === 'POST' && url.pathname === '/setup/import-license') {
        const ct = req.headers['content-type'] ?? '';
        let result: { ok: true; org_id: string };
        if (ct.includes('multipart/form-data')) {
          const files = await parseMultipart(req);
          const file = files.find((f) => f.fieldName === 'license' || f.filename.endsWith('.ocx'));
          if (!file) return sendJson(res, 400, { error: 'FILE_MISSING', message: '라이선스 파일을 선택하세요.' });
          result = setup.importLicense(file.data.toString('utf8'));
        } else {
          const body = JSON.parse(await readBody(req)) as { license?: string; license_path?: string };
          if (body.license_path?.trim()) {
            result = setup.importLicenseFromPath(body.license_path);
          } else {
            const raw = body.license ?? '';
            if (!raw.trim()) {
              return sendJson(res, 400, { error: 'LICENSE_EMPTY', message: '라이선스 파일을 선택하세요.' });
            }
            result = setup.importLicense(raw);
          }
        }
        setup.tryAutoImportBundle();
        return sendJson(res, 200, result);
      }

      if (method === 'POST' && url.pathname === '/setup/import-bundle') {
        const lic = license.getStatus();
        if (lic.mode !== 'full') {
          return sendJson(res, 403, { error: 'LICENSE_REQUIRED', message: '먼저 라이선스 파일을 등록하세요.' });
        }
        license.assertFeature('manager');
        const overwrite = url.searchParams.get('overwrite') === '1';
        let raw = '';
        const ct = req.headers['content-type'] ?? '';
        if (ct.includes('multipart/form-data')) {
          const files = await parseMultipart(req);
          const file = files.find(
            (f) => f.fieldName === 'bundle' || f.filename.endsWith('.enc'),
          );
          if (!file) return sendJson(res, 400, { error: 'FILE_MISSING' });
          raw = file.data.toString('utf8');
        } else {
          const body = JSON.parse(await readBody(req)) as { bundle?: string };
          raw = body.bundle ?? '';
        }
        if (!raw.trim()) return sendJson(res, 400, { error: 'BUNDLE_EMPTY' });
        const result = setup.importBundle(raw, { overwrite });
        return sendJson(res, 200, result);
      }

      const workspaceReady =
        Boolean(workspaceUiDir)
        && existsSync(path.join(workspaceUiDir, 'index.html'));

      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        if (!workspaceReady) {
          return sendJson(res, 503, {
            error: 'WORKSPACE_UI_NOT_BUILT',
            message: 'Primary workspace UI is unavailable. Run npm run workspace:build.',
          });
        }
        return sendWorkspaceIndex(res, workspaceUiDir, appVersion);
      }

      if (method === 'GET' && workspaceReady && url.pathname.startsWith('/assets/')) {
        const filePath = path.join(workspaceUiDir, url.pathname.slice(1));
        assertPathUnder(workspaceUiDir, filePath);
        if (!existsSync(filePath)) {
          return sendJson(res, 404, { error: 'Not found' });
        }
        return sendUiAsset(res, filePath);
      }

      // Workspace SPA fallback (non-API GETs). Removed UI paths stay 404.
      if (
        method === 'GET'
        && workspaceReady
        && !url.pathname.startsWith('/api')
        && !looksLikeApiPath(url.pathname)
        && !isRemovedUiPath(url.pathname)
        && !path.extname(url.pathname)
      ) {
        return sendWorkspaceIndex(res, workspaceUiDir, appVersion);
      }

      const attachMatch = url.pathname.match(/^\/attachments\/([^/]+)$/);
      if (attachMatch) {
        const id = attachMatch[1];
        const session = url.searchParams.get('session') ?? undefined;

        if (method === 'GET') {
          const rec = attachments.get(id, session);
          if (!rec) return sendJson(res, 404, { error: 'NOT_FOUND' });
          const bytes = attachments.readBytes(id, session);
          if (!bytes) return sendJson(res, 404, { error: 'NOT_FOUND' });
          res.writeHead(200, {
            'Content-Type': rec.mime,
            'Content-Disposition': `inline; filename="${encodeURIComponent(rec.original_name)}"`,
          });
          res.end(bytes);
          return;
        }

        if (method === 'DELETE') {
          license.assertWritable();
          const ok = attachments.delete(id, session);
          return sendJson(res, ok ? 200 : 404, { ok });
        }
      }

      if (method === 'POST' && url.pathname === '/attachments') {
        license.assertWritable();
        const session = sessionFromReq(req);
        // #region agent log
        fetch('http://127.0.0.1:7742/ingest/aa87bd6c-3a9c-4926-a486-5ea0781a9b81',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b87a06'},body:JSON.stringify({sessionId:'b87a06',runId:'pre-fix',hypothesisId:'H1_H4',location:'dispatch.ts:POST-/attachments',message:'attachment upload entry',data:{contentType:String(req.headers['content-type']??'').slice(0,200),sessionLen:session.length,ua:String(req.headers['user-agent']??'').slice(0,80)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        const saved = await attachments.uploadFromRequest(req, session);
        return sendJson(res, 201, { attachments: saved.map(publicAttachment) });
      }

      if (method === 'GET' && url.pathname === '/models/picker') {
        const payload = await buildModelPicker(modelRegistry, getOverrides(), providerStore, {
          refreshRemote: url.searchParams.get('refresh') === '1',
        });
        return sendJson(res, 200, payload);
      }

      if (method === 'PUT' && url.pathname === '/models/company-selection') {
        license.assertWritable();
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as { model_ids?: unknown; reset?: boolean };
        if (body.reset === true) {
          const next = saveUserOverrides(userConfigPath, { company_model_ids: undefined }, cqrRoot);
          return sendJson(res, 200, { ok: true, company_model_ids: next.company_model_ids ?? null });
        }
        if (!Array.isArray(body.model_ids)) {
          return sendJson(res, 400, { error: 'MODEL_IDS_REQUIRED', message: 'MY 모델 목록을 선택하세요.' });
        }
        const modelIds = [...new Set(body.model_ids.map(String).map((id) => id.trim()).filter(Boolean))];
        if (modelIds.length === 0 || modelIds.length > 40 || modelIds.some((id) => id.length > 256)) {
          return sendJson(res, 400, {
            error: 'MODEL_SELECTION_INVALID',
            message: 'MY 모델은 1개 이상 40개 이하로 선택하세요.',
          });
        }
        const next = saveUserOverrides(userConfigPath, { company_model_ids: modelIds }, cqrRoot);
        return sendJson(res, 200, { ok: true, company_model_ids: next.company_model_ids });
      }

      if (method === 'GET' && url.pathname === '/providers') {
        return sendJson(res, 200, { providers: providerStore.listPublic() });
      }

      if (method === 'POST' && url.pathname === '/providers/user') {
        license.assertWritable();
        license.assertFeature('manager');
        const ovr = getOverrides();
        if (ovr.local_only) {
          return sendJson(res, 403, {
            error: 'LOCAL_ONLY_BLOCKED',
            message: '로컬 전용 모드에서는 개인 클라우드 API를 추가할 수 없습니다.',
          });
        }
        const body = JSON.parse(await readBody(req)) as {
          name?: string;
          base_url?: string;
          model_id?: string;
          api_key?: string;
          compatibility?: 'openai' | 'anthropic';
        };
        try {
          const providers = providerStore.createUserProvider({
            name: body.name ?? 'Personal API',
            base_url: body.base_url ?? '',
            model_id: body.model_id ?? '',
            api_key: body.api_key ?? '',
            compatibility: body.compatibility as 'openai' | 'anthropic',
          });
          return sendJson(res, 200, { providers });
        } catch (e: unknown) {
          if (e instanceof ProviderError) {
            return sendJson(res, 400, { error: e.code, message: e.message });
          }
          throw e;
        }
      }

      const providerUserDelete = url.pathname.match(/^\/providers\/user\/([^/]+)$/);
      if (method === 'DELETE' && providerUserDelete) {
        license.assertWritable();
        license.assertFeature('manager');
        try {
          const providers = providerStore.deleteUserProvider(decodeURIComponent(providerUserDelete[1]));
          return sendJson(res, 200, { providers });
        } catch (e: unknown) {
          if (e instanceof ProviderError) {
            return sendJson(res, 400, { error: e.code, message: e.message });
          }
          throw e;
        }
      }

      const providerKeyMatch = url.pathname.match(/^\/providers\/([^/]+)\/key$/);
      if (providerKeyMatch) {
        const providerId = providerKeyMatch[1];
        if (method === 'PUT') {
          license.assertWritable();
          license.assertFeature('manager');
          const ovr = getOverrides();
          if (ovr.local_only && !isProviderAllowedLocalOnly(providerId, providerStore.listDefinitions())) {
            return sendJson(res, 403, {
              error: 'LOCAL_ONLY_BLOCKED',
              message: '로컬 전용 모드에서는 Ollama(NAS)만 등록할 수 있습니다.',
            });
          }
          const body = JSON.parse(await readBody(req)) as {
            api_key: string;
            base_url?: string;
            model_id?: string;
            name?: string;
          };
          try {
            const providers = providerStore.saveKey(providerId, body.api_key, {
              base_url: body.base_url,
              model_id: body.model_id,
              name: body.name,
            });
            const def = providerStore.getDefinition(providerId);
            if (def?.custom || def?.user_defined) {
              invalidateRemoteModelCache(providerId);
            }
            return sendJson(res, 200, { providers });
          } catch (e: unknown) {
            if (e instanceof ProviderError) {
              return sendJson(res, 400, { error: e.code, message: e.message });
            }
            throw e;
          }
        }
        if (method === 'DELETE') {
          license.assertWritable();
          license.assertFeature('manager');
          try {
            const providers = providerStore.deleteKey(providerId);
            return sendJson(res, 200, { providers });
          } catch (e: unknown) {
            if (e instanceof ProviderError) {
              return sendJson(res, 400, { error: e.code, message: e.message });
            }
            throw e;
          }
        }
      }

      const providerTestMatch = url.pathname.match(/^\/providers\/([^/]+)\/test$/);
      if (method === 'POST' && providerTestMatch) {
        license.assertFeature('manager');
        const providerId = providerTestMatch[1];
        const def = providerStore.getDefinition(providerId);
        if (!def) {
          return sendJson(res, 404, {
            provider_id: providerId,
            ok: false,
            error: 'PROVIDER_UNKNOWN',
            note: 'Unknown provider',
          });
        }
        const secret = providerStore.getSecret(providerId);
        let testBody: {
          api_key?: string;
          base_url?: string;
          model_id?: string;
        } = {};
        try {
          const raw = await readBody(req);
          if (raw.trim()) testBody = JSON.parse(raw) as typeof testBody;
        } catch {
          return sendJson(res, 400, {
            provider_id: providerId,
            ok: false,
            note: 'Invalid test request body',
            error: 'BAD_REQUEST',
          });
        }

        const apiKey = testBody.api_key?.trim() || secret?.api_key || '';
        const baseUrl = (
          providerId === 'custom'
            ? def.base_url
            : testBody.base_url?.trim() || secret?.base_url || def?.base_url || ''
        ).replace(/\/$/, '');
        let modelId =
          testBody.model_id?.trim() || secret?.model_id?.trim() || def?.default_model || '';
        let listErr: string | null = null;
        let listedModels: string[] = [];

        if (providerId === 'ollama') {
          if (!apiKey || !baseUrl) {
            return sendJson(res, 400, {
              provider_id: providerId,
              ok: false,
              note: 'API key and Base URL required',
              error: 'PROVIDER_NOT_CONFIGURED',
            });
          }
          const result = await testOllamaReachable(baseUrl, apiKey);
          return sendJson(res, result.ok ? 200 : 502, {
            provider_id: providerId,
            ok: result.ok,
            note: result.note,
          });
        }

        if (def?.custom && apiKey && baseUrl) {
          try {
            listedModels = await listRemoteModels(baseUrl, apiKey);
            const curated = curateRemoteModels(listedModels);
            if (!modelId) {
              modelId =
                resolveDefaultOwuiModel(listedModels) ?? curated[0]?.id ?? listedModels[0] ?? '';
            }
          } catch (e: unknown) {
            listErr = e instanceof Error ? e.message : String(e);
          }
        }

        if (!apiKey || !baseUrl || !modelId) {
          const note =
            listErr ??
            (listedModels.length === 0 && def?.custom
              ? 'Remote model list is empty. Save settings, then retry. Check the company OpenRouter API key.'
              : 'API key, Base URL, or Model ID is missing.');
          return sendJson(res, 502, {
            provider_id: providerId,
            ok: false,
            note,
            models_count: listedModels.length,
            error: 'PROVIDER_NOT_CONFIGURED',
          });
        }

        const selection = await selectWireApiAtConfiguration(
          { ...def, base_url: baseUrl },
          modelId,
          secret?.wire_api,
          (candidate) => testConnection(baseUrl, apiKey, modelId, candidate),
        );
        const { result, selected: selectedWireApi, attempts } = selection;
        const nativeProbe =
          result.ok && selectedWireApi && def.kind === 'openai_compatible' && providerId !== 'ollama'
            ? await testNativeToolConnection(baseUrl, apiKey, modelId, selectedWireApi)
            : null;
        const nativeRequired = selectedWireApi ? requiresNativeTools(selectedWireApi) : false;
        const selectedToolProtocol = nativeRequired || nativeProbe?.ok ? 'native' as const : 'text' as const;
        if (result.ok && selectedWireApi && nativeRequired && !nativeProbe?.ok) {
          return sendJson(res, 502, {
            provider_id: providerId,
            ok: false,
            error: 'NATIVE_TOOLS_REQUIRED',
            note: `${wireApiLabel(selectedWireApi)} 연결은 됐지만 네이티브 function tools가 지원되지 않습니다: ${nativeProbe?.note ?? 'probe unavailable'}`,
            models_count: def?.custom ? listedModels.length : undefined,
            models_count_shown: def?.custom ? curateRemoteModels(listedModels).length : undefined,
            chat_base_url: result.chat_base_url,
            wire_api: selectedWireApi,
            tool_protocol: 'native',
            native_tools_ok: false,
            configuration_attempts: attempts.length > 1 ? attempts : undefined,
          });
        }
        if (
          result.ok
          && selectedWireApi
          && (
            secret?.wire_api !== selectedWireApi
            || secret?.tool_protocol !== selectedToolProtocol
          )
        ) {
          providerStore.saveKey(providerId, '', {
            base_url: baseUrl,
            model_id: modelId,
            wire_api: selectedWireApi,
            tool_protocol: selectedToolProtocol,
          });
        }
        let modelsCount = listedModels.length;
        let modelsShown = def?.custom ? curateRemoteModels(listedModels).length : listedModels.length;
        let note = result.note;
        if (def?.custom && result.ok) {
          if (modelsCount === 0) {
            try {
              listedModels = await listRemoteModels(baseUrl, apiKey);
              modelsCount = listedModels.length;
              modelsShown = curateRemoteModels(listedModels).length;
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              note = `OK · chat works, model list failed: ${msg.slice(0, 120)}`;
            }
          }
          if (modelsCount > 0) {
            note = `${result.note} · 원격 ${modelsCount}개 → 표시 ${modelsShown}개`;
          } else if (result.ok && !note.includes('model list failed')) {
            note = 'OK · chat works but 0 models listed';
          }
        }
        if (result.ok && nativeProbe) {
          note = nativeProbe.ok
            ? `${note} · 네이티브 tools 고정`
            : `${note} · Chat Completions TEXT tools 호환 모드 (${nativeProbe.note})`;
        }
        return sendJson(res, result.ok ? 200 : 502, {
          provider_id: providerId,
          ok: result.ok,
          note,
          models_count: def?.custom ? modelsCount : undefined,
          models_count_shown: def?.custom ? modelsShown : undefined,
          chat_base_url: result.chat_base_url,
          wire_api: selectedWireApi,
          tool_protocol: selectedToolProtocol,
          native_tools_ok: nativeProbe?.ok ?? false,
          configuration_attempts: attempts.length > 1 ? attempts : undefined,
        });
      }

      if (method === 'PUT' && url.pathname === '/providers/default') {
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as { id: string | null };
        const providers = providerStore.setDefault(body.id ?? null);
        return sendJson(res, 200, { providers });
      }

      if (method === 'GET' && url.pathname === '/models') {
        const kind = url.searchParams.get('kind') as ModelKind | null;
        const doc = modelRegistry.load();
        let list = doc.models;
        if (kind === 'llm' || kind === 'image') list = list.filter((m) => m.kind === kind);
        return sendJson(res, 200, {
          ...doc,
          models: list,
          llama_binary: llamaBinary,
        });
      }

      if (method === 'GET' && url.pathname === '/models/runtime') {
        return sendJson(res, 200, { llama_binary: llamaBinary });
      }

      if (method === 'POST' && url.pathname === '/models/upload') {
        license.assertWritable();
        license.assertFeature('manager');
        license.assertFeature('local_models');
        const result = await modelUpload.uploadFromRequest(req);
        return sendJson(res, 201, result);
      }

      if (method === 'POST' && url.pathname === '/models/scan') {
        license.assertFeature('manager');
        license.assertFeature('local_models');
        const doc = modelRegistry.scan();
        return sendJson(res, 200, doc);
      }

      if (method === 'PUT' && url.pathname === '/models/default') {
        license.assertFeature('manager');
        const body = JSON.parse(await readBody(req)) as { kind: ModelKind; id: string | null };
        if (body.kind !== 'llm' && body.kind !== 'image') {
          return sendJson(res, 400, { error: 'INVALID_KIND' });
        }
        try {
          const doc = modelRegistry.setDefault(body.kind, body.id);
          return sendJson(res, 200, doc);
        } catch {
          return sendJson(res, 404, { error: 'MODEL_NOT_FOUND' });
        }
      }

      const verifyModelMatch = url.pathname.match(/^\/models\/([^/]+)\/verify$/);
      if (method === 'POST' && verifyModelMatch) {
        license.assertFeature('manager');
        license.assertFeature('local_models');
        const id = verifyModelMatch[1];
        const m = modelRegistry.getById(id);
        if (!m) return sendJson(res, 404, { error: 'MODEL_NOT_FOUND' });
        if (m.kind !== 'llm') {
          return sendJson(res, 400, { error: 'VERIFY_LLM_ONLY' });
        }
        const deep = url.searchParams.get('deep') === '1';
        let result: { ok: boolean; note: string };
        if (deep && llamaBinary.found && llamaBinary.path) {
          result = await deepVerifyWithServer(m.path, llamaBinary.path);
        } else {
          result = quickVerifyGguf(m.path);
          if (result.ok && !llamaBinary.found) {
            result = { ok: true, note: 'GGUF_OK_BINARY_MISSING' };
          }
        }
        const doc = modelRegistry.updateVerification(id, result.ok, result.note);
        return sendJson(res, 200, { id, ...result, registry: doc });
      }

      const imgOutMatch = url.pathname.match(/^\/outputs\/images\/([^/]+)\/([^/]+)$/);
      if (method === 'GET' && imgOutMatch) {
        const [, session, file] = imgOutMatch;
        const fp = orchestrator.getImagePath(session, file);
        if (!fp) return sendJson(res, 404, { error: 'NOT_FOUND' });
        assertPathUnder(imageOut, fp);
        const ext = path.extname(file).toLowerCase();
        const mime =
          ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : 'image/png';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(readFileSync(fp));
        return;
      }

      const browserOutMatch = url.pathname.match(/^\/outputs\/browser\/([^/]+)\/([^/]+)$/);
      if (method === 'GET' && browserOutMatch) {
        const [, folder, file] = browserOutMatch;
        const fp = orchestrator.getBrowserScreenshotPath(folder, file);
        if (!fp) return sendJson(res, 404, { error: 'NOT_FOUND' });
        assertPathUnder(path.join(cqrRoot, 'data', 'outputs', 'browser'), fp);
        const ext = path.extname(file).toLowerCase();
        const mime =
          ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : 'image/png';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(readFileSync(fp));
        return;
      }

      const crawlOutMatch = url.pathname.match(/^\/outputs\/crawl\/([^/]+)\/([^/]+)\.md$/);
      if (method === 'GET' && crawlOutMatch) {
        const [, session, file] = crawlOutMatch;
        const fp = path.join(cqrRoot, 'data', 'outputs', 'crawl', session, file);
        if (!existsSync(fp)) return sendJson(res, 404, { error: 'NOT_FOUND' });
        assertPathUnder(path.join(cqrRoot, 'data', 'outputs', 'crawl'), fp);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(readFileSync(fp, 'utf8'));
        return;
      }

      const resOutMatch = url.pathname.match(/^\/outputs\/research\/([^/]+)\/([^/]+)\.md$/);
      if (method === 'GET' && resOutMatch) {
        const [, session, id] = resOutMatch;
        const md = orchestrator.getResearchMarkdown(session, id);
        if (!md) return sendJson(res, 404, { error: 'NOT_FOUND' });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(md);
        return;
      }

      const webOutMatch = url.pathname.match(/^\/outputs\/web\/([^/]+)\/([^/]+)$/);
      if (method === 'GET' && webOutMatch) {
        const [, session, file] = webOutMatch;
        const safeFile = path.basename(file);
        if (!session || safeFile !== file) return sendJson(res, 404, { error: 'NOT_FOUND' });
        const fp = path.join(cqrRoot, 'data', 'outputs', 'web', session, safeFile);
        if (!existsSync(fp)) return sendJson(res, 404, { error: 'NOT_FOUND' });
        assertPathUnder(path.join(cqrRoot, 'data', 'outputs', 'web'), fp);
        const ext = path.extname(file).toLowerCase();
        const mime =
          ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : ext === '.png'
                  ? 'image/png'
                  : ext === '.md'
                    ? 'text/markdown; charset=utf-8'
                    : ext === '.json'
                      ? 'application/json; charset=utf-8'
                      : ext === '.pdf'
                        ? 'application/pdf'
                        : ext === '.txt' || ext === '.html' || ext === '.htm' || ext === '.csv'
                          ? 'text/plain; charset=utf-8'
                          : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(readFileSync(fp));
        return;
      }

      if (method === 'GET' && url.pathname === '/workspace') {
        license.assertFeature('chat');
        const sessions = sessionStore.list();
        const overrides = loadUserOverrides(userConfigPath);
        const devRoot = overrides.dev_workspace_root?.trim() || null;
        if (devRoot) {
          try {
            projectStore.upsertWorkspaceRoot(devRoot);
          } catch {
            /* invalid path in config — omit from active */
          }
        }
        const workspace_trees = projectStore
          .listWorkspaceRoots()
          .map((r) => projectStore.buildNodeTree(r.id, sessions))
          .filter((n): n is NonNullable<typeof n> => n !== null);
        let active_workspace_project_id: string | null = null;
        if (devRoot) {
          const active = projectStore.findByFolderPath(devRoot);
          active_workspace_project_id = active?.id ?? null;
        }
        const active_tree =
          (active_workspace_project_id
            ? workspace_trees.find((t) => t.id === active_workspace_project_id)
            : null) ??
          workspace_trees[0] ??
          null;
        const projects = projectStore.listGeneral(sessions).map((p) => ({
          ...p,
          sessions: sessionStore.listByProject(p.id),
        }));
        return sendJson(res, 200, {
          dev_workspace_root: devRoot,
          active_workspace_project_id,
          workspace_root_project_id: active_workspace_project_id,
          workspace_tree: active_tree,
          workspace_trees,
          move_targets: projectStore.listMoveTargets(),
          projects,
          standalone_sessions: sessionStore.listStandalone(),
        });
      }

      if (method === 'GET' && url.pathname === '/projects') {
        license.assertFeature('chat');
        const sessions = sessionStore.list();
        return sendJson(res, 200, { projects: projectStore.list(sessions) });
      }

      const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
      if (projectMatch) {
        const pid = projectMatch[1];
        if (method === 'PUT') {
          license.assertWritable();
          license.assertFeature('chat');
          const body = JSON.parse(await readBody(req)) as { title?: string };
          const rec = projectStore.rename(pid, body.title ?? '');
          if (!rec) return sendJson(res, 404, { error: 'NOT_FOUND' });
          return sendJson(res, 200, rec);
        }
        if (method === 'DELETE') {
          license.assertWritable();
          license.assertFeature('chat');
          const rec = projectStore.get(pid);
          if (!rec) return sendJson(res, 404, { error: 'NOT_FOUND' });
          if (!projectStore.isDeletable(pid)) {
            return sendJson(res, 404, { error: 'NOT_FOUND' });
          }
          const unlink = url.searchParams.get('unlink') === '1';
          const descendantIds = projectStore.collectDescendantIds(pid);
          const allIds = [pid, ...descendantIds];
          if (unlink) {
            for (const id of allIds) sessionStore.unlinkAllFromProject(id);
          } else {
            for (const id of allIds) sessionStore.deleteAllInProject(id);
          }
          const ok = projectStore.delete(pid);
          if (ok && projectStore.resolveKind(rec) === 'workspace_root' && rec.folder_path) {
            const overrides = loadUserOverrides(userConfigPath);
            const active = overrides.dev_workspace_root?.trim();
            if (active && path.resolve(active) === path.resolve(rec.folder_path)) {
              saveUserOverrides(userConfigPath, { dev_workspace_root: undefined }, cqrRoot);
            }
          }
          return sendJson(res, ok ? 200 : 404, { ok });
        }
      }

      if (method === 'POST' && url.pathname === '/projects') {
        license.assertWritable();
        license.assertFeature('chat');
        try {
          const body = JSON.parse(await readBody(req)) as {
            title?: string;
            kind?: 'folder' | 'project';
            parent_id?: string | null;
          };
          const rec = projectStore.create({
            title: body.title,
            kind: body.kind ?? 'project',
            parent_id: body.parent_id ?? null,
          });
          return sendJson(res, 201, rec);
        } catch (e: unknown) {
          if (e instanceof ProjectStoreError) {
            return sendJson(res, 400, { error: e.code, message: e.message });
          }
          throw e;
        }
      }

      if (method === 'GET' && url.pathname === '/skills') {
        license.assertFeature('chat');
        return sendJson(res, 200, {
          skills: listAllSkills(cqrRoot),
          capabilities: {},
        });
      }

      if (method === 'GET' && url.pathname === '/organization-module') {
        license.assertFeature('chat');
        return sendJson(res, 200, describeOrganizationModuleStatus(cqrRoot));
      }

      if (method === 'POST' && url.pathname === '/organization-module/check') {
        license.assertFeature('chat');
        try {
          const update = await checkOrganizationModuleUpdate(cqrRoot);
          return sendJson(res, 200, { update });
        } catch (e: unknown) {
          if (e instanceof OrganizationModuleError) {
            return sendJson(res, 400, { error: e.code, message: e.message });
          }
          throw e;
        }
      }

      if (method === 'POST' && url.pathname === '/organization-module/apply') {
        license.assertWritable();
        license.assertFeature('chat');
        try {
          const installed = await applyOrganizationModuleUpdate(cqrRoot);
          return sendJson(res, 200, { installed });
        } catch (e: unknown) {
          if (e instanceof OrganizationModuleError) {
            return sendJson(res, 400, { error: e.code, message: e.message });
          }
          throw e;
        }
      }

      if (method === 'POST' && url.pathname === '/organization-module/install') {
        license.assertWritable();
        license.assertFeature('chat');
        try {
          const body = JSON.parse(await readBody(req)) as { zip_path?: string };
          if (!body.zip_path?.trim()) {
            return sendJson(res, 400, {
              error: 'MODULE_ZIP_PATH_REQUIRED',
              message: '회사 팩 ZIP 파일 경로를 입력하세요.',
            });
          }
          const result = installOrganizationModule({
            cqrRoot,
            zipPath: body.zip_path.trim().replace(/^"|"$/g, ''),
          });
          return sendJson(res, 201, { installed: result.installed });
        } catch (e: unknown) {
          if (e instanceof OrganizationModuleError) {
            return sendJson(res, 400, { error: e.code, message: e.message });
          }
          throw e;
        }
      }

      if (method === 'POST' && url.pathname === '/skills/import') {
        license.assertWritable();
        license.assertFeature('chat');
        try {
          const body = JSON.parse(await readBody(req)) as { zip_path?: string };
          if (!body.zip_path?.trim()) {
            return sendJson(res, 400, { error: 'SKILL_ZIP_PATH_REQUIRED', message: 'ZIP 파일 경로를 입력하세요.' });
          }
          const rec = userSkillStore.installPackage(body.zip_path, isBundledSkillId);
          return sendJson(res, 201, {
            ...rec,
            mode: `user:${rec.id}`,
            source: 'user',
            editable: false,
            removable: true,
          });
        } catch (e: unknown) {
          if (e instanceof UserSkillError) {
            return sendJson(res, 400, { error: e.code, message: e.message });
          }
          throw e;
        }
      }

      const skillMatch = url.pathname.match(/^\/skills\/([^/]+)$/);
      if (skillMatch) {
        const skillId = decodeURIComponent(skillMatch[1]);
        if (method === 'GET') {
          license.assertFeature('chat');
          if (isBundledSkillId(skillId)) {
            const bundled = listAllSkills(cqrRoot).find((s) => s.id === skillId);
            if (!bundled) return sendJson(res, 404, { error: 'NOT_FOUND' });
            const prompt = getSkillSystemPromptByMode(bundled.mode, cqrRoot);
            return sendJson(res, 200, { ...bundled, prompt: prompt ?? '' });
          }
          const orgDef = getOrganizationSkillDef(skillId, cqrRoot);
          if (orgDef) {
            const prompt = getSkillSystemPromptByMode(orgDef.mode, cqrRoot);
            return sendJson(res, 200, {
              id: skillId,
              label: orgDef.label,
              mode: orgDef.mode,
              source: 'organization',
              editable: false,
              removable: false,
              feature: orgDef.feature,
              prompt: prompt ?? '',
            });
          }
          const rec = userSkillStore.get(skillId);
          if (!rec) return sendJson(res, 404, { error: 'NOT_FOUND' });
          return sendJson(res, 200, {
            id: rec.id,
            label: rec.label,
            mode: `user:${rec.id}`,
            source: 'user',
            editable: rec.install_kind !== 'package',
            removable: true,
            install_kind: rec.install_kind ?? 'prompt',
            description: rec.description,
            file_count: rec.file_count,
            anchors_ko: rec.anchors_ko,
            anchors_en: rec.anchors_en,
            prompt: rec.prompt,
            created_at: rec.created_at,
            updated_at: rec.updated_at,
          });
        }
        if (method === 'PUT') {
          license.assertWritable();
          license.assertFeature('chat');
          if (isBundledSkillId(skillId)) {
            return sendJson(res, 403, { error: 'BUNDLED_SKILL_READONLY' });
          }
          if (getOrganizationSkillDef(skillId, cqrRoot)) {
            return sendJson(res, 403, { error: 'ORGANIZATION_SKILL_READONLY' });
          }
          try {
            const body = JSON.parse(await readBody(req)) as {
              label?: string;
              prompt?: string;
              anchors_ko?: string[];
              anchors_en?: string[];
            };
            const rec = userSkillStore.update(skillId, body);
            return sendJson(res, 200, rec);
          } catch (e: unknown) {
            if (e instanceof UserSkillError) {
              return sendJson(res, 400, { error: e.code, message: e.message });
            }
            throw e;
          }
        }
        if (method === 'DELETE') {
          license.assertWritable();
          license.assertFeature('chat');
          if (isBundledSkillId(skillId)) {
            return sendJson(res, 403, { error: 'BUNDLED_SKILL_READONLY' });
          }
          if (getOrganizationSkillDef(skillId, cqrRoot)) {
            return sendJson(res, 403, { error: 'ORGANIZATION_SKILL_READONLY' });
          }
          const ok = userSkillStore.delete(skillId);
          return sendJson(res, ok ? 200 : 404, { ok });
        }
      }

      if (method === 'POST' && url.pathname === '/skills') {
        license.assertWritable();
        license.assertFeature('chat');
        try {
          const body = JSON.parse(await readBody(req)) as {
            id: string;
            label: string;
            prompt: string;
            anchors_ko?: string[];
            anchors_en?: string[];
          };
          if (isBundledSkillId(body.id)) {
            return sendJson(res, 403, { error: 'BUNDLED_SKILL_ID' });
          }
          if (getOrganizationSkillDef(body.id, cqrRoot)) {
            return sendJson(res, 403, { error: 'ORGANIZATION_SKILL_ID' });
          }
          const rec = userSkillStore.create(body);
          return sendJson(res, 201, rec);
        } catch (e: unknown) {
          if (e instanceof UserSkillError) {
            return sendJson(res, 400, { error: e.code, message: e.message });
          }
          throw e;
        }
      }

      // --- Local agent plugins (data/agent-plugins) ---
      if (method === 'GET' && url.pathname === '/agent-plugins') {
        license.assertFeature('chat');
        ensureShippedProductPlugins(cqrRoot);
        const plugins = listAgentPlugins(cqrRoot, { useCache: false }).map((p) => ({
          id: p.id,
          name: p.manifest.name,
          enabled: p.enabled,
          risk: p.manifest.risk,
          description: p.manifest.description,
          runner: p.manifest.runner.kind,
          lab_smoke: isLabSmokePluginId(p.id),
        }));
        return sendJson(res, 200, {
          plugins,
          templates: listPluginTemplates(cqrRoot, { forUi: true }),
          lab_smoke_count: plugins.filter((p) => p.lab_smoke).length,
        });
      }

      if (method === 'GET' && url.pathname === '/agent-plugins/templates') {
        license.assertFeature('chat');
        ensureShippedProductPlugins(cqrRoot);
        return sendJson(res, 200, { templates: listPluginTemplates(cqrRoot, { forUi: true }) });
      }

      if (method === 'POST' && url.pathname === '/agent-plugins/purge-lab-smoke') {
        license.assertWritable();
        license.assertFeature('chat');
        let body: { confirm?: boolean };
        try {
          body = JSON.parse(await readBody(req)) as { confirm?: boolean };
        } catch {
          return sendJson(res, 400, { error: 'INVALID_JSON', message: 'JSON body required' });
        }
        const raw = purgeLabSmokePlugins(cqrRoot, { confirm: body.confirm === true });
        const doc = JSON.parse(raw) as { ok?: boolean };
        return sendJson(res, doc.ok ? 200 : 400, JSON.parse(raw));
      }

      if (method === 'POST' && url.pathname === '/agent-plugins') {
        license.assertWritable();
        license.assertFeature('chat');
        const body = JSON.parse(await readBody(req)) as {
          id?: string;
          confirm?: boolean;
          tool_json?: string | Record<string, unknown>;
          run_source?: string;
          template_id?: string;
        };
        if (body.template_id) {
          const raw = installAgentPluginFromTemplate(cqrRoot, {
            template_id: body.template_id,
            id: body.id,
            confirm: body.confirm === true,
          });
          const doc = JSON.parse(raw) as { ok?: boolean };
          return sendJson(res, doc.ok ? 201 : 400, JSON.parse(raw));
        }
        const raw = installAgentPlugin(cqrRoot, {
          id: String(body.id ?? ''),
          confirm: body.confirm === true,
          tool_json: body.tool_json,
          run_source: body.run_source,
          created_by: 'user',
        });
        const doc = JSON.parse(raw) as { ok?: boolean };
        return sendJson(res, doc.ok ? 201 : 400, JSON.parse(raw));
      }

      const pluginEnableMatch = url.pathname.match(/^\/agent-plugins\/([^/]+)\/enabled$/);
      if (pluginEnableMatch && method === 'POST') {
        license.assertWritable();
        license.assertFeature('chat');
        const pluginId = decodeURIComponent(pluginEnableMatch[1]);
        const body = JSON.parse(await readBody(req)) as {
          enabled?: boolean;
          confirm?: boolean;
        };
        const raw = setAgentPluginEnabled(cqrRoot, {
          id: pluginId,
          enabled: body.enabled === true,
          confirm: body.confirm === true,
        });
        const doc = JSON.parse(raw) as { ok?: boolean };
        return sendJson(res, doc.ok ? 200 : 400, JSON.parse(raw));
      }

      const pluginDeleteMatch = url.pathname.match(/^\/agent-plugins\/([^/]+)$/);
      if (pluginDeleteMatch && method === 'DELETE') {
        license.assertWritable();
        license.assertFeature('chat');
        const pluginId = decodeURIComponent(pluginDeleteMatch[1]);
        let body: { confirm?: boolean } = {};
        try {
          const rawBody = await readBody(req);
          if (rawBody.trim()) body = JSON.parse(rawBody) as { confirm?: boolean };
        } catch {
          /* empty body ok if confirm via query */
        }
        const confirm =
          body.confirm === true || url.searchParams.get('confirm') === '1';
        const raw = uninstallAgentPlugin(cqrRoot, { id: pluginId, confirm });
        const doc = JSON.parse(raw) as { ok?: boolean };
        return sendJson(res, doc.ok ? 200 : 400, JSON.parse(raw));
      }

      if (method === 'GET' && url.pathname === '/sessions') {
        license.assertFeature('chat');
        return sendJson(res, 200, { sessions: sessionStore.list() });
      }

      const sessionUndoMatch = url.pathname.match(/^\/sessions\/([^/]+)\/undo$/);
      if (sessionUndoMatch && method === 'POST') {
        license.assertWritable();
        license.assertFeature('chat');
        const sid = sessionUndoMatch[1];
        const result = sessionStore.popLastTurn(sid);
        if (!result) return sendJson(res, 404, { error: 'NOTHING_TO_UNDO' });
        return sendJson(res, 200, result);
      }

      const sessionPolicyMatch = url.pathname.match(/^\/sessions\/([^/]+)\/execution-policy$/);
      if (sessionPolicyMatch && method === 'PUT') {
        license.assertWritable();
        license.assertFeature('chat');
        const body = JSON.parse(await readBody(req)) as {
          reasoning?: ReasoningLevel;
          autopilot?: 'off' | 'auto' | 'on';
          approval?: 'ask' | 'delegate' | 'autopilot';
        };
        const rec = sessionStore.setExecutionPolicy(sessionPolicyMatch[1], normalizeExecutionPolicy(body));
        if (!rec) return sendJson(res, 404, { error: 'NOT_FOUND' });
        return sendJson(res, 200, sessionStore.publicRecord(rec));
      }

      const sessionWorkspaceMatch = url.pathname.match(/^\/sessions\/([^/]+)\/workspace$/);
      if (sessionWorkspaceMatch && method === 'PUT') {
        license.assertWritable();
        license.assertFeature('chat');
        const body = JSON.parse(await readBody(req)) as { workspace_project_id?: string | null };
        if (!Object.prototype.hasOwnProperty.call(body, 'workspace_project_id')) {
          return sendJson(res, 400, { error: 'WORKSPACE_PROJECT_ID_REQUIRED' });
        }
        const workspaceProjectId = String(body.workspace_project_id ?? '').trim() || null;
        if (workspaceProjectId) {
          const workspaceProject = projectStore.get(workspaceProjectId);
          if (
            !workspaceProject
            || projectStore.resolveKind(workspaceProject) !== 'workspace_root'
            || !workspaceProject.folder_path?.trim()
          ) {
            return sendJson(res, 400, {
              error: 'WORKSPACE_ROOT_REQUIRED',
              message: '등록된 작업 폴더만 이 채팅에 연결할 수 있습니다.',
            });
          }
          try {
            assertDevWorkspaceRoot(workspaceProject.folder_path, {
              allowNas: hasNasWriteConsent(getOverrides()),
            });
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            return sendJson(res, 403, { error: 'WORKSPACE_NOT_ALLOWED', message });
          }
        }
        const rec = sessionStore.setWorkspaceProject(sessionWorkspaceMatch[1], workspaceProjectId);
        if (!rec) return sendJson(res, 404, { error: 'NOT_FOUND' });
        return sendJson(res, 200, sessionStore.publicRecord(rec));
      }

      const sessionSummaryMatch = url.pathname.match(/^\/sessions\/([^/]+)\/summary$/);
      if (sessionSummaryMatch && method === 'POST') {
        license.assertWritable();
        license.assertFeature('chat');
        const source = sessionStore.load(sessionSummaryMatch[1]);
        if (!source) return sendJson(res, 404, { error: 'NOT_FOUND' });
        const body = JSON.parse(await readBody(req)) as { create_session?: boolean; model?: string };
        const transcript = source.messages
          .filter((message) => !message.model_exclude && message.content.trim())
          .map((message) => `${message.role === 'user' ? '사용자' : '어시스턴트'}: ${message.content.trim()}`)
          .join('\n\n')
          .slice(-60_000);
        if (!transcript) return sendJson(res, 400, { error: 'EMPTY_SESSION' });

        const targetId = randomUUID();
        sessionStore.ensure(targetId, {
          project_id: body.create_session ? (source.project_id ?? null) : null,
          execution_policy: source.execution_policy,
        });
        if (body.create_session && source.workspace_project_id) {
          sessionStore.setWorkspaceProject(targetId, source.workspace_project_id);
        }
        try {
          const result = await orchestrator.handle({
            mode: 'chat',
            model: body.model || 'auto',
            message: [
              '아래 대화를 후속 대화에 사용할 수 있도록 한국어로 압축 요약하라.',
              '사용자 의도, 핵심 논리, 결정 사항, 미해결 쟁점과 다음에 이어갈 내용만 보존한다.',
              '도구 호출, 실행 로그, 파일 경로, 작업 공간 설정, 모델/승인 정책 같은 기능적 메타데이터는 제외한다.',
              '새로운 작업을 실행하거나 제안하지 말고 요약문만 출력한다.',
              '',
              transcript,
            ].join('\n'),
          }, targetId);
          const summary = result.content.trim();
          if (body.create_session) {
            sessionStore.replaceWithSummary(targetId, summary, source.title);
          } else {
            sessionStore.delete(targetId);
          }
          return sendJson(res, 200, {
            summary,
            session_id: body.create_session ? targetId : null,
          });
        } catch (error) {
          sessionStore.delete(targetId);
          throw error;
        }
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const sid = sessionMatch[1];
        if (method === 'GET') {
          license.assertFeature('chat');
          const rec = sessionStore.load(sid);
          if (!rec) return sendJson(res, 404, { error: 'NOT_FOUND' });
          return sendJson(res, 200, sessionStore.publicRecord(rec));
        }
        if (method === 'PUT') {
          license.assertWritable();
          license.assertFeature('chat');
          const body = JSON.parse(await readBody(req)) as { project_id?: string | null };
          if (!('project_id' in body)) {
            return sendJson(res, 400, { error: 'PROJECT_ID_REQUIRED' });
          }
          const projectId =
            body.project_id === undefined || body.project_id === null || body.project_id === ''
              ? null
              : body.project_id;
          if (projectId && !projectStore.get(projectId)) {
            return sendJson(res, 404, { error: 'PROJECT_NOT_FOUND' });
          }
          const rec = sessionStore.setProject(sid, projectId);
          if (!rec) return sendJson(res, 404, { error: 'NOT_FOUND' });
          if (projectId) projectStore.touch(projectId);
          return sendJson(res, 200, sessionStore.publicRecord(rec));
        }
        if (method === 'DELETE') {
          license.assertWritable();
          license.assertFeature('chat');
          const ok = sessionStore.delete(sid);
          return sendJson(res, ok ? 200 : 404, { ok });
        }
      }

      if (method === 'POST' && url.pathname === '/sessions') {
        license.assertWritable();
        license.assertFeature('chat');
        const body = JSON.parse(await readBody(req)) as { id?: string; project_id?: string | null };
        const id = body.id?.trim() || randomUUID();
        const hasProjectField = Object.prototype.hasOwnProperty.call(body, 'project_id');
        let ensureOpts: Parameters<typeof sessionStore.ensure>[1];
        if (hasProjectField) {
          const projectId =
            body.project_id === undefined || body.project_id === null || body.project_id === ''
              ? null
              : body.project_id;
          if (projectId && !projectStore.get(projectId)) {
            return sendJson(res, 400, { error: 'PROJECT_NOT_FOUND' });
          }
          ensureOpts = {
            project_id: projectId,
            execution_policy: defaultExecutionPolicyFromConfig(loadUserOverrides(userConfigPath)),
          };
        }
        ensureOpts = {
          ...ensureOpts,
          execution_policy: defaultExecutionPolicyFromConfig(loadUserOverrides(userConfigPath)),
        };
        const rec = sessionStore.ensure(id, ensureOpts);
        if (ensureOpts?.project_id) projectStore.touch(ensureOpts.project_id);
        return sendJson(res, 201, sessionStore.publicRecord(rec));
      }

      if (method === 'POST' && url.pathname === '/chat/tool-approval') {
        license.assertWritable();
        license.assertFeature('chat');
        const body = await readBody(req);
        let doc: { id?: string; approved?: boolean };
        try {
          doc = JSON.parse(body) as { id?: string; approved?: boolean };
        } catch {
          return sendJson(res, 400, { error: 'INVALID_JSON' });
        }
        const id = typeof doc.id === 'string' ? doc.id.trim() : '';
        if (!id) return sendJson(res, 400, { error: 'MISSING_ID' });
        const ok = resolveToolApproval(id, doc.approved === true);
        return sendJson(res, ok ? 200 : 404, { ok, id, approved: doc.approved === true });
      }

      if (method === 'POST' && url.pathname === '/chat/stream') {
        license.assertWritable();
        license.assertFeature('chat');
        const session = sessionFromReq(req);
        const body = await readBody(req);
        const reqDoc = parseChatRequest(body);
        if (reqDoc.mode === 'image_gen') license.assertFeature('image_generation');
        if (reqDoc.mode === 'deep_research') license.assertFeature('deep_research');
        if (reqDoc.mode === 'web_dev') license.assertFeature('web_dev');
        if (reqDoc.mode === 'web_landing') license.assertFeature('web_dev');
        if (reqDoc.mode === 'browser_automation') license.assertFeature('browser_automation');
        if (reqDoc.mode === 'browser_agent') license.assertFeature('browser_automation');
        if (reqDoc.mode === 'web_crawl') license.assertFeature('deep_research');
        await orchestrator.handleStream(reqDoc, session, res, clientAbortSignal(req));
        return;
      }

      if (method === 'POST' && url.pathname === '/chat') {
        license.assertWritable();
        license.assertFeature('chat');
        const session = sessionFromReq(req);
        const body = await readBody(req);
        const reqDoc = parseChatRequest(body);
        if (reqDoc.mode === 'image_gen') license.assertFeature('image_generation');
        if (reqDoc.mode === 'deep_research') license.assertFeature('deep_research');
        if (reqDoc.mode === 'web_dev') license.assertFeature('web_dev');
        if (reqDoc.mode === 'web_landing') license.assertFeature('web_dev');
        if (reqDoc.mode === 'browser_automation') license.assertFeature('browser_automation');
        if (reqDoc.mode === 'browser_agent') license.assertFeature('browser_automation');
        if (reqDoc.mode === 'web_crawl') license.assertFeature('deep_research');
        const result = await orchestrator.handle(reqDoc, session);
        return sendJson(res, 200, result);
      }

      if (method === 'POST' && url.pathname === '/generate/image') {
        license.assertFeature('image_generation');
        const session = sessionFromReq(req);
        const body = JSON.parse(await readBody(req)) as { prompt: string };
        const result = await orchestrator.handle(
          { message: body.prompt, mode: 'image_gen', attachments: [] },
          session,
        );
        return sendJson(res, 200, result);
      }

      if (method === 'POST' && url.pathname === '/research') {
        license.assertFeature('deep_research');
        const session = sessionFromReq(req);
        const body = JSON.parse(await readBody(req)) as { query: string };
        const result = await orchestrator.handle(
          { message: body.query, mode: 'deep_research', attachments: [] },
          session,
        );
        return sendJson(res, 200, result);
      }

      if (method === 'POST' && url.pathname === '/browser/screenshot') {
        license.assertWritable();
        license.assertFeature('browser_automation');
        const body = JSON.parse(await readBody(req)) as { url: string; session_id?: string };
        if (!body.url?.trim()) return sendJson(res, 400, { error: 'URL_REQUIRED' });
        const overrides = getOverrides();
        const result = await browserScreenshotViaMcp(body.url.trim(), {
          cqrRoot,
          headless: overrides.playwright_headless !== false,
          allowLocalhost: overrides.playwright_allow_localhost === true,
          sessionId: body.session_id,
        });
        const status = result.ok ? 200 : 503;
        return sendJson(res, status, result);
      }

      if (method === 'POST' && url.pathname === '/browser/navigate') {
        license.assertWritable();
        license.assertFeature('browser_automation');
        const body = JSON.parse(await readBody(req)) as { url: string };
        if (!body.url?.trim()) return sendJson(res, 400, { error: 'URL_REQUIRED' });
        const overrides = getOverrides();
        const result = await browserNavigateViaMcp(body.url.trim(), {
          cqrRoot,
          headless: overrides.playwright_headless !== false,
          allowLocalhost: overrides.playwright_allow_localhost === true,
        });
        const status = result.ok ? 200 : 503;
        return sendJson(res, status, result);
      }

      return sendJson(res, 404, { error: 'Not found' });
}
