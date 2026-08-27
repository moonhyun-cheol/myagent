import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const orig = execSync('git show HEAD:core/src/api-server.ts', { encoding: 'utf8', cwd: root });
const lines = orig.split(/\r?\n/);
let body = lines.slice(149, 1128).join('\n');

body = body.replace(
  `        const automaton = await getAutomatonDiagnostics(loadDeployDefaults(cqrRoot).live_automaton_root);
        return sendJson(res, 200, {`,
  `        const automaton = await getAutomatonDiagnostics(loadDeployDefaults(cqrRoot).live_automaton_root);
        const playwright = probePlaywright(cqrRoot);
        const playwrightMcp = await getPlaywrightMcpDiagnostics(cqrRoot);
        return sendJson(res, 200, {`,
);

body = body.replace(
  `          automaton_mcp: automaton,
          deploy_parity: {`,
  `          automaton_mcp: automaton,
          playwright,
          playwright_mcp: playwrightMcp,
          deploy_parity: {`,
);

body = body.replace(
  `                'web_dev',
                'image_generation',`,
  `                'web_dev',
                'browser_automation',
                'image_generation',`,
);

body = body.replaceAll(
  `        if (reqDoc.mode === 'web_dev') license.assertFeature('web_dev');`,
  `        if (reqDoc.mode === 'web_dev') license.assertFeature('web_dev');
        if (reqDoc.mode === 'browser_automation') license.assertFeature('browser_automation');`,
);

const browserRoutes = `
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
`;

body = body.replace(
  /(\s+return sendJson\(res, 404, \{ error: 'Not found' \}\);)\s*$/,
  `${browserRoutes}$1`,
);

const header = `import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPathUnder, assertWritablePath } from '../security/path-guard.js';
import { SecurityError } from '../security/errors.js';
import { assertDevWorkspaceRoot } from '../security/dev-workspace-guard.js';
import { hasNasWriteConsent, buildNasWriteConsent } from '../security/nas-write-consent.js';
import { browseDirectories } from '../agent/dev-workspace-fs.js';
import { loadUserOverrides, saveUserOverrides, isProviderAllowedLocalOnly } from '../config/user-overrides.js';
import { loadDeployDefaults } from '../config/deploy-defaults.js';
import { loadProviderCatalog, getProviderDef } from '../providers/provider-catalog.js';
import { testOllamaReachable } from '../inference/local-llama-runtime.js';
import type { ModelKind } from '../models/types.js';
import { buildModelPicker, invalidateRemoteModelCache } from '../models/model-picker.js';
import { testConnection, listRemoteModels } from '../providers/openai-compatible.js';
import { curateRemoteModels, resolveDefaultOwuiModel } from '../providers/remote-model-curate.js';
import { quickVerifyGguf, deepVerifyWithServer } from '../inference/llama-backend.js';
import { probePlaywright } from '../browser/playwright-probe.js';
import { browserNavigateViaMcp, browserScreenshotViaMcp, getPlaywrightMcpDiagnostics } from '../browser/playwright-mcp-bridge.js';
import { parseChatRequest } from '../chat/chat-orchestrator.js';
import { clientAbortSignal } from '../chat/abort.js';
import { ProjectStoreError } from '../projects/project-store.js';
import { parseMultipart } from '../attachments/multipart.js';
import { getErrorReportPublicConfig, sendErrorReportNow } from '../support/error-report-service.js';
import type { ErrorReportSettings } from '../config/user-overrides.js';
import { computeMachineId } from '../license/machine-id.js';
import { listAllSkills, isBundledSkillId, getSkillSystemPromptByMode } from '../skills/skill-registry.js';
import { UserSkillError } from '../skills/user-skill-store.js';
import { getAutomatonDiagnostics } from '../automaton/adapter.js';
import type { ApiContext } from '../http/api-context.js';
import { sendJson, readBody, sessionFromReq } from '../http/json.js';
import { publicAttachment } from '../http/attachment-dto.js';

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
    uiDir,
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

`;

const outPath = path.join(root, 'core/src/routes/dispatch.ts');
fs.writeFileSync(outPath, `${header}${body}\n}\n`, 'utf8');
console.log('wrote', outPath, 'lines', body.split('\n').length);
