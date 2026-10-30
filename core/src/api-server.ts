import { createServer } from 'node:http';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveCqrRoot, getBootstrapPaths, ensureDataDirs } from './bootstrap.js';
import { ensureShippedProductPlugins } from './agent/agent-plugin-store.js';
import { FileLicenseGate } from './license/file-license-gate.js';
import { AttachmentService } from './attachments/attachment-service.js';
import { loadUserOverrides } from './config/user-overrides.js';
import { ModelRegistry } from './models/model-registry.js';
import { ModelUploadService } from './models/model-upload.js';
import { ProviderStore } from './providers/provider-store.js';
import { findLlamaServerBinary } from './inference/llama-backend.js';
import { ChatOrchestrator } from './chat/chat-orchestrator.js';
import { SessionStore } from './sessions/session-store.js';
import { ProjectStore } from './projects/project-store.js';
import { SetupService } from './setup/setup-service.js';
import { readProductVersion } from './config/product-version.js';
import { startAutoLogReportLoop } from './support/error-report-service.js';
import { UserSkillStore } from './skills/user-skill-store.js';
import { sweepCheckpoints } from './agent/agent-checkpoint.js';
import { sweepSessionTemp } from './sessions/session-temp-gc.js';
import type { ApiContext } from './http/api-context.js';
import { handleApiError } from './http/api-error-handler.js';
import { dispatchApiRequest } from './routes/dispatch.js';
import { PersonalSchedulerService } from './scheduler/personal-scheduler-service.js';
import { PersonalSchedulerRuntime } from './scheduler/personal-scheduler-runtime.js';
import { buildSchedulerTraceEntries, type SchedulerTraceEntry } from './scheduler/run-trace.js';
import {
  registerPersonalSchedulerRuntime,
  unregisterPersonalSchedulerRuntime,
} from './scheduler/runtime-registry.js';
import { startVisibleBrowserBridge, getVisibleBrowserBridge } from './browser/visible-browser-bridge.js';
import { writeInstallRootPointer } from './setup/install-root-pointer.js';
import { warmModelPricingIfMissing } from './models/model-picker.js';
import { trackSlowRequest } from './routes/slow-request-log.js';
import { checkLocalApiRequest } from './security/local-api-guard.js';
import { configureBrowserUrlBlocklistFile } from './browser/url-guard.js';

export async function createApiServer(port: number) {
  const cqrRoot = resolveCqrRoot();
  const paths = getBootstrapPaths(cqrRoot);
  // Self-heal %LOCALAPPDATA%\MYAgent\install-root.json every boot (moved/restored/updated
  // trees). Contract: never blocks startup — the writer swallows all errors.
  writeInstallRootPointer(cqrRoot, {
    log: (line) => {
      try {
        appendFileSync(path.join(paths.logsDir, 'api-start.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
      } catch {
        /* ignore log write errors */
      }
    },
  });
  ensureDataDirs(paths);
  try {
    ensureShippedProductPlugins(paths.cqrRoot);
  } catch {
    /* non-fatal — plugins panel / GET will retry */
  }
  const license = new FileLicenseGate(paths.vaultDir, cqrRoot);
  const userConfigPath = path.join(paths.dataDir, 'config', 'user-overrides.json');
  const getOverrides = () => loadUserOverrides(userConfigPath);
  // `browser_blocked_urls` is re-read on change (mtime) by every browser URL check.
  configureBrowserUrlBlocklistFile(userConfigPath);
  const initialOverrides = getOverrides();
  const attachments = new AttachmentService(
    paths.attachmentsDir,
    cqrRoot,
    initialOverrides.attachment_max_bytes ?? 20 * 1024 * 1024,
  );
  const modelsRoot = path.join(paths.dataDir, 'models');
  const modelRegistry = new ModelRegistry(modelsRoot, cqrRoot);
  const modelUpload = new ModelUploadService(
    modelRegistry,
    cqrRoot,
    initialOverrides.model_upload_max_bytes ?? 32 * 1024 * 1024 * 1024,
  );
  const providerStore = new ProviderStore(path.join(paths.vaultDir, 'provider-keys.json'), cqrRoot);
  const projectStore = new ProjectStore(path.join(paths.dataDir, 'projects'), cqrRoot);
  const userSkillStore = new UserSkillStore(path.join(paths.dataDir, 'skills'), cqrRoot);
  const sessionStore = new SessionStore(
    path.join(paths.dataDir, 'sessions'),
    cqrRoot,
    (projectId) => projectStore.touch(projectId),
    (rec) => {
      const pid = rec.workspace_project_id || rec.project_id;
      return pid ? projectStore.resolveWorkspaceRootForProject(pid) : null;
    },
  );
  const setup = new SetupService(paths.vaultDir, cqrRoot, providerStore);
  providerStore.migrateVaultIfNeeded();
  setup.tryAutoImportFromRoot();
  void setup.tryCentralActivation().then(async () => {
    setup.syncProviderRegistry();
    await setup.ensureOpenClawAdapter();
  });
  setup.syncProviderRegistry();
  void setup.ensureOpenClawAdapter();
  const llamaBinary = findLlamaServerBinary(cqrRoot);
  const researchOut = path.join(paths.dataDir, 'outputs', 'research');
  const imageOut = path.join(paths.dataDir, 'outputs', 'images');
  const orchestrator = new ChatOrchestrator(
    cqrRoot,
    attachments,
    modelRegistry,
    providerStore,
    sessionStore,
    projectStore,
    userConfigPath,
    paths.dataDir,
    paths.vaultDir,
    researchOut,
    imageOut,
  );
  const personalScheduler = PersonalSchedulerService.forRoot(cqrRoot);
  const personalSchedulerRuntime = new PersonalSchedulerRuntime(
    personalScheduler,
    async (task, run) => {
      const sessionId = `automation-${run.id}`;
      const startedAt = Date.now();
      let runError: string | undefined;
      try {
        const response = await orchestrator.handle({
          message: task.instruction,
          attachments: [],
          execution_context: 'background',
        }, sessionId);
        const feedAttachments = [
          ...(response.mutatedPaths ?? []).map((filePath) => ({
            name: path.basename(filePath),
            path: filePath,
          })),
          ...(response.images ?? []).map((image, index) => ({
            name: `image-${index + 1}`,
            path: image.url,
          })),
          ...(response.browserHandoff ? [{
            name: response.browserHandoff.title || '백그라운드 브라우저',
            mime: 'application/x-my-agent-browser-handoff',
            browser_url: response.browserHandoff.url,
          }] : []),
        ];
        return { content: response.content, attachments: feedAttachments };
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        // 임시 대화를 지우기 전에 중간 과정(메시지·도구 호출)을 trace.jsonl로 보존한다.
        try {
          const finishedAt = Date.now();
          const entries: SchedulerTraceEntry[] = [
            { type: 'run', event: 'start', at: new Date(startedAt).toISOString() },
            ...buildSchedulerTraceEntries(sessionStore.load(sessionId)?.messages),
            {
              type: 'run',
              event: 'end',
              at: new Date(finishedAt).toISOString(),
              ok: runError === undefined,
              ...(runError !== undefined ? { error: runError } : {}),
              duration_ms: finishedAt - startedAt,
            },
          ];
          personalScheduler.writeRunTrace(run.id, entries);
        } catch {
          /* trace 기록 실패가 실행 결과 기록을 막지 않는다 */
        }
        sessionStore.delete(sessionId);
      }
    },
  );

  const workspaceUiDir = path.join(cqrRoot, 'ui', 'workspace', 'dist');
  const appVersion = readProductVersion(cqrRoot);

  const ctx: ApiContext = {
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
    personalScheduler,
    personalSchedulerRuntime,
  };

  try {
    appendFileSync(
      path.join(paths.logsDir, 'api-start.log'),
      `${new Date().toISOString()} start v${appVersion} port=${port}\n`,
      'utf8',
    );
  } catch {
    /* ignore log write errors */
  }

  startAutoLogReportLoop(cqrRoot, paths.dataDir, paths.vaultDir);

  // Housekeeping is deliberately deferred until after server.listen(). A large checkpoint
  // tree must not hold the first visible window behind the health gate.
  setImmediate(() => {
    try {
      const swept = sweepCheckpoints(cqrRoot);
      if (swept.removedSessions || swept.removedCheckpoints) {
        appendFileSync(
          path.join(paths.logsDir, 'api-start.log'),
          `${new Date().toISOString()} checkpoint-sweep sessions=${swept.removedSessions} checkpoints=${swept.removedCheckpoints} freedMB=${Math.round(swept.freedBytes / 1048576)}\n`,
          'utf8',
        );
      }
    } catch {
      /* housekeeping must never block boot */
    }
    try {
      const tempSwept = sweepSessionTemp(cqrRoot, sessionStore.loadAll(), {
        workspaceRootForSession: (sid) => {
          const rec = sessionStore.load(sid);
          if (!rec) return null;
          const pid = rec.workspace_project_id || rec.project_id;
          return pid ? projectStore.resolveWorkspaceRootForProject(pid) : null;
        },
      });
      if (tempSwept.removedFiles) {
        appendFileSync(
          path.join(paths.logsDir, 'api-start.log'),
          `${new Date().toISOString()} session-temp-sweep files=${tempSwept.removedFiles} keptShared=${tempSwept.keptShared} freedMB=${Math.round(tempSwept.freedBytes / 1048576)}\n`,
          'utf8',
        );
      }
    } catch {
      /* housekeeping must never block boot */
    }
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';
    const guard = checkLocalApiRequest(req, port);
    if (!guard.ok) {
      // Browser-originated cross-site / DNS-rebinding request. Never dispatch it; log the
      // reason only (no body, no query) so blocked probes are visible without leaking data.
      try {
        appendFileSync(
          path.join(paths.logsDir, 'api-guard.log'),
          `${new Date().toISOString()} blocked=${guard.reason} ${method} ${url.pathname} ${JSON.stringify(guard.detail)}\n`,
          'utf8',
        );
      } catch {
        /* logging must never block the response */
      }
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'LOCAL_API_FORBIDDEN', reason: guard.reason }));
      req.resume();
      return;
    }
    trackSlowRequest(paths.logsDir, req, res, url.pathname);

    try {
      await dispatchApiRequest(ctx, req, res, url, method);
    } catch (e: unknown) {
      handleApiError(res, e);
    }
  });

  // Node's 5s default closes idle keep-alive sockets that clients (undici/WebView2) may
  // still reuse, surfacing as ECONNRESET whenever a caller pauses between requests.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  server.once('listening', () => {
    startVisibleBrowserBridge(port);
    registerPersonalSchedulerRuntime(cqrRoot, personalSchedulerRuntime);
    personalSchedulerRuntime.start();
    // Premium-tier badges need provider prices. Fetch once in the background only when no
    // price table exists yet; delayed so it never competes with the first window paint.
    setTimeout(() => {
      try {
        warmModelPricingIfMissing(providerStore);
      } catch {
        /* best-effort */
      }
    }, 3_000).unref?.();
  });
  server.once('close', () => {
    getVisibleBrowserBridge()?.stop();
    unregisterPersonalSchedulerRuntime(cqrRoot, personalSchedulerRuntime);
    void personalSchedulerRuntime.shutdown().finally(() => personalScheduler.close());
  });

  return server;
}

export function startApiServer(port: number): void {
  void (async () => {
    const server = await createApiServer(port);
    server.listen(port, '127.0.0.1', () => {
      console.log(`MY Agent API http://127.0.0.1:${port}`);
    });
  })();
}
