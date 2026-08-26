import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
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

export async function createApiServer(port: number) {
  const cqrRoot = resolveCqrRoot();
  const paths = getBootstrapPaths(cqrRoot);
  ensureDataDirs(paths);
  try {
    ensureShippedProductPlugins(paths.cqrRoot);
  } catch {
    /* non-fatal — plugins panel / GET will retry */
  }
  const license = new FileLicenseGate(paths.vaultDir, cqrRoot);
  const userConfigPath = path.join(paths.dataDir, 'config', 'user-overrides.json');
  const getOverrides = () => loadUserOverrides(userConfigPath);
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
  const setup = new SetupService(paths.vaultDir, cqrRoot, license, providerStore);
  providerStore.migrateVaultIfNeeded();
  setup.tryAutoImportFromRoot();
  void setup.tryCentralActivation().then(async () => {
    license.reload();
    setup.syncProviderRegistry();
    await setup.ensureOpenClawAdapter();
  });
  license.reload();
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

    try {
      await dispatchApiRequest(ctx, req, res, url, method);
    } catch (e: unknown) {
      // #region agent log
      fetch('http://127.0.0.1:7742/ingest/aa87bd6c-3a9c-4926-a486-5ea0781a9b81',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b87a06'},body:JSON.stringify({sessionId:'b87a06',runId:'pre-fix',hypothesisId:'H3',location:'api-server.ts:catch',message:'dispatch catch reached',data:{method,path:url.pathname,errMsg:e instanceof Error ? e.message.slice(0,200) : String(e).slice(0,200)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      handleApiError(res, e);
    }
  });

  // Node's 5s default closes idle keep-alive sockets that clients (undici/WebView2) may
  // still reuse, surfacing as ECONNRESET whenever a caller pauses between requests.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  return server;
}

export function startApiServer(port = 10200): void {
  void (async () => {
    const server = await createApiServer(port);
    server.listen(port, '127.0.0.1', () => {
      console.log(`MY Agent API http://127.0.0.1:${port}`);
    });
  })();
}
