/**
 * Mutate-review reject, end to end through the real run loop.
 *
 * Mock OpenAI-compatible LLM → runCodeAgent (core/dist) → tools on disk →
 * result.checkpointId / result.mutatedPaths → rollbackWorkspaceCheckpoint called
 * with the same arguments the POST /workspace/checkpoint/rollback route passes.
 *
 * Variants: `reviewer` answers approvals as a decision model would (the
 * before-model-approval checkpoint path), `http` sends the reject through
 * dispatchApiRequest (POST /workspace/checkpoint/rollback, GET .../preview),
 * `tool` undoes through the agent tool workspace_rollback (executeAgentTool),
 * which is the only undo surface the product exposes today (design doc 2.16).
 *
 * Not covered here: the workspace UI (the review pane is not mounted, see
 * docs/multi-agent-team-run-design.md 2.14).
 * Usage: node tools/verify-mutate-reject-e2e.mjs   (needs a current core/dist)
 */
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (rel) => pathToFileURL(join(productRoot, 'core', 'dist', rel)).href;

const results = [];
function record(id, ok, detail = '') {
  results.push({ id, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const ORIGINAL = {
  'a.ts': 'export const a = 1;\n',
  'b.ts': 'export const b = 1;\n',
  'old.ts': 'export const old = 1;\n',
  'moved-src.ts': 'export const moved = 1;\n',
  'doomed.ts': 'export const doomed = 1;\n',
};

function stage() {
  const cqrRoot = mkdtempSync(join(tmpdir(), 'cqr-reject-e2e-'));
  mkdirSync(join(cqrRoot, 'data', 'vault'), { recursive: true });
  const workspace = join(cqrRoot, 'workspace');
  mkdirSync(workspace, { recursive: true });
  for (const [rel, body] of Object.entries(ORIGINAL)) writeFileSync(join(workspace, rel), body);
  spawnSync('git', ['init'], { cwd: workspace, windowsHide: true });
  return { cqrRoot, workspace };
}

const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/** Scripted turns: read → edit a → edit b → rename → edit new → create → patch move → done. */
const SCRIPT = [
  [
    call('r1', 'read_file', { path: 'a.ts' }),
    call('r2', 'read_file', { path: 'b.ts' }),
    call('r3', 'read_file', { path: 'old.ts' }),
    call('r4', 'read_file', { path: 'moved-src.ts' }),
  ],
  [call('e1', 'edit_file', { path: 'a.ts', old_text: 'a = 1', new_text: 'a = 2' })],
  [call('e2', 'edit_file', { path: 'b.ts', old_text: 'b = 1', new_text: 'b = 2' })],
  [call('m1', 'rename_file', { path: 'old.ts', new_path: 'new.ts' })],
  [call('r5', 'read_file', { path: 'new.ts' })],
  [call('e3', 'edit_file', { path: 'new.ts', old_text: 'old = 1', new_text: 'old = 2' })],
  [call('w1', 'write_file', { path: 'created.ts', content: 'export const created = 1;\n' })],
  [
    call('p1', 'apply_patch', {
      files: [{ action: 'move', path: 'moved-src.ts', new_path: 'moved-dst.ts' }],
    }),
  ],
];

/**
 * The run loop does not map one request to one executed turn (it adds its own
 * auto-read steps and may ask again), so the mock answers from conversation
 * state: the first scripted turn whose tool results are not all present yet.
 */
/**
 * Workspace-internal edits need no approval; delete_file does. Deleting first makes
 * the decision-model branch create the run's checkpoint, and the second delete
 * makes that branch extend a checkpoint the plain branch already extended.
 */
const SCRIPT_REVIEWER = [
  [
    call('r1', 'read_file', { path: 'a.ts' }),
    call('r2', 'read_file', { path: 'b.ts' }),
    call('r3', 'read_file', { path: 'old.ts' }),
    call('r4', 'read_file', { path: 'doomed.ts' }),
  ],
  [call('d1', 'delete_file', { path: 'doomed.ts', confirm: true })],
  [call('e1', 'edit_file', { path: 'a.ts', old_text: 'a = 1', new_text: 'a = 2' })],
  [call('m1', 'rename_file', { path: 'old.ts', new_path: 'new.ts' })],
  [call('d2', 'delete_file', { path: 'b.ts', confirm: true })],
];

function startMockLlm(SCRIPT) {
  const toolResults = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && /chat\/completions/.test(req.url || '')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      for (const msg of body.messages || []) {
        if (msg.role === 'tool' && !toolResults.some((t) => t.id === msg.tool_call_id)) {
          toolResults.push({
            id: msg.tool_call_id,
            text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          });
        }
      }
      const seen = new Set(
        (body.messages || []).filter((msg) => msg.role === 'tool').map((msg) => msg.tool_call_id),
      );
      const calls = SCRIPT.find((turnCalls) => !turnCalls.every((c) => seen.has(c.id)));
      const message = calls
        ? { role: 'assistant', content: null, tool_calls: calls }
        : { role: 'assistant', content: '요청한 수정을 마쳤습니다. (mock LLM)', tool_calls: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-reject-e2e',
          object: 'chat.completion',
          choices: [{ index: 0, message, finish_reason: calls ? 'tool_calls' : 'stop' }],
          model: body.model || 'mock-reject-e2e',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done({ server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, toolResults });
    });
  });
}

function listCheckpointDirs(cqrRoot) {
  const base = join(cqrRoot, 'data', 'agent-checkpoints');
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      if (existsSync(join(full, 'meta.json'))) found.push(full);
      else walk(full);
    }
  };
  walk(base);
  return found;
}

const read = (ws, rel) => (existsSync(join(ws, rel)) ? readFileSync(join(ws, rel), 'utf8') : null);

/** Real route handler on a throwaway port; workspace comes from user-overrides (no session header). */
async function startApi(mods, staged) {
  const userConfigPath = join(staged.cqrRoot, 'user-overrides.json');
  writeFileSync(userConfigPath, JSON.stringify({ dev_workspace_root: staged.workspace }));
  const ctx = {
    // Every request resolves its folder through the conversation (sessionFromReq
    // falls back to 'default'), so the binding is stubbed; the route code is real.
    sessionStore: { load: () => ({ allowed_paths: [staged.workspace] }) },
    projectStore: {},
    cqrRoot: staged.cqrRoot,
    paths: {},
    port: 0,
    appVersion: 'test',
    workspaceUiDir: null,
    workKitLauncherUiDir: null,
    userConfigPath,
    imageOut: join(staged.cqrRoot, 'images'),
    getOverrides: () => ({}),
    license: { assertWritable() {}, assertFeature() {} },
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await mods.dispatch.dispatchApiRequest(ctx, req, res, url, req.method ?? 'GET');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: error?.stack || String(error) }));
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function runOnce(label, mods, pickRejectPaths, variant = {}) {
  const staged = stage();
  const script = variant.script ?? SCRIPT;
  const mock = await startMockLlm(script);
  try {
    const store = new mods.providerStore.ProviderStore(
      join(staged.cqrRoot, 'data', 'vault', 'provider-keys.json'),
      staged.cqrRoot,
    );
    const list = store.createUserProvider({
      name: 'Reject E2E Mock',
      base_url: mock.baseUrl,
      model_id: 'mock-reject-e2e',
      api_key: 'sk-e2e-mock',
      compatibility: 'openai',
    });
    const providerId = list.find((p) => p.user_defined)?.id || list[list.length - 1]?.id;
    const sessionId = `reject-e2e-${label}-${Date.now()}`;
    const approvals = [];
    const result = await mods.codeAgent.runCodeAgent({
      workspaceRoot: staged.workspace,
      cqrRoot: staged.cqrRoot,
      userMessage:
        'a.ts와 b.ts의 값을 2로 바꾸고, old.ts를 new.ts로 이름을 바꾼 뒤 값을 2로 고치고, created.ts를 만들고, moved-src.ts를 moved-dst.ts로 옮겨줘.',
      systemPrompt: 'You are MY Agent code agent. Use tools only.',
      history: [],
      providerId,
      modelId: 'mock-reject-e2e',
      providerStore: store,
      nasWriteConsent: false,
      sessionId,
      autopilot: true,
      maxSteps: 20,
      forceToolPack: 'web_dev',
      mutationsOverride: true,
      onToolApproval: async (request) => {
        approvals.push(request.tool);
        return variant.reviewer
          ? { approved: true, by: 'reviewer', reviewer: 'mock-reviewer' }
          : true;
      },
      onStatus: () => {},
    });

    const mutated = [...(result?.mutatedPaths || [])].sort();
    if (process.env.REJECT_E2E_DEBUG) {
      console.log(`[debug ${label}] steps=${result?.steps} notice=${JSON.stringify(result?.applicationNotice ?? null)}`);
      console.log(`[debug ${label}] content=${String(result?.content || '').slice(0, 300)}`);
      console.log(`[debug ${label}] files=${readdirSync(staged.workspace).filter((n) => n !== '.git').join(',')}`);
      for (const t of mock.toolResults) console.log(`[debug ${label}] ${t.id}: ${t.text.replace(/\s+/g, ' ').slice(0, 260)}`);
    }
    const failedTools = mock.toolResults.filter((t) => /"ok"\s*:\s*false/.test(t.text));
    record(
      `${label}.run.tools_succeeded`,
      failedTools.length === 0 && mock.toolResults.length >= script.flat().length,
      `tool results=${mock.toolResults.length}` +
        (failedTools.length ? ` failed=${failedTools.map((t) => `${t.id}:${t.text.slice(0, 160)}`).join(' | ')}` : ''),
    );
    record(
      `${label}.run.disk_after_agent`,
      variant.diskOk ? variant.diskOk(staged.workspace) :
      read(staged.workspace, 'a.ts')?.includes('a = 2') &&
        read(staged.workspace, 'b.ts')?.includes('b = 2') &&
        read(staged.workspace, 'old.ts') === null &&
        read(staged.workspace, 'new.ts')?.includes('old = 2') &&
        read(staged.workspace, 'created.ts') !== null &&
        read(staged.workspace, 'moved-src.ts') === null &&
        read(staged.workspace, 'moved-dst.ts') !== null,
    );
    const expectMutated = variant.expectMutated ??
      ['a.ts', 'b.ts', 'created.ts', 'moved-dst.ts', 'moved-src.ts', 'new.ts', 'old.ts'];
    record(
      `${label}.run.mutated_paths_both_sides`,
      JSON.stringify(mutated) === JSON.stringify(expectMutated),
      mutated.join(','),
    );
    const cpDirs = listCheckpointDirs(staged.cqrRoot);
    record(
      `${label}.run.single_checkpoint`,
      cpDirs.length === 1 && Boolean(result?.checkpointId) && cpDirs[0].endsWith(String(result.checkpointId)),
      `count=${cpDirs.length} id=${result?.checkpointId} dirs=${cpDirs.map((d) => relative(staged.cqrRoot, d)).join(';')}`,
    );
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(join(cpDirs[0], 'meta.json'), 'utf8'));
    } catch {
      /* reported by the check below */
    }
    record(`${label}.run.meta_keys`, true, Object.keys(meta).join(','));
    record(`${label}.run.approvals`, true, `count=${approvals.length} tools=${approvals.join(',')} label=${meta.label}`);
    if (variant.reviewer) {
      record(
        `${label}.run.reviewer_checkpoint_path_taken`,
        approvals.filter((t) => t === 'delete_file').length === 2 &&
          String(meta.label || '').startsWith('before-model-approval:'),
        `approvals=${approvals.length} label=${meta.label}`,
      );
    }

    const rejectPaths = pickRejectPaths(mutated);
    let doc;
    let raw;
    if (variant.http) {
      const api = await startApi(mods, staged);
      try {
        const pre = await fetch(
          `${api.base}/workspace/checkpoint/preview?checkpoint_id=${encodeURIComponent(result?.checkpointId || '')}` +
            `&path=a.ts&session_id=${encodeURIComponent(sessionId)}`,
        );
        const preText = await pre.text();
        record(`${label}.http.preview_200`, pre.status === 200, `status=${pre.status} ${preText.replace(/\s+/g, ' ').slice(0, 200)}`);
        const res = await fetch(`${api.base}/workspace/checkpoint/rollback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Body shape of rollbackWorkspaceCheckpoint() in ui/workspace/src/api/myAgentClient.ts.
          body: JSON.stringify({
            checkpoint_id: result?.checkpointId,
            session_id: sessionId,
            confirm: true,
            paths: rejectPaths,
          }),
        });
        raw = await res.text();
        record(`${label}.http.rollback_200`, res.status === 200, `status=${res.status}`);
        doc = JSON.parse(raw);
      } finally {
        await new Promise((done) => api.server.close(done));
      }
    } else if (variant.tool) {
      const toolCtx = { cqrRoot: staged.cqrRoot, sessionId };
      const runTool = async (id, args) =>
        (
          await mods.toolExecute.executeAgentTool(
            staged.workspace,
            call(id, 'workspace_rollback', args),
            { allowNas: false },
            toolCtx,
          )
        ).output;
      // The model never sees the auto checkpoint id: an empty id must list it.
      const listRaw = await runTool('rb0', { checkpoint_id: '', confirm: true });
      let listDoc = {};
      try {
        listDoc = JSON.parse(listRaw);
      } catch {
        /* reported below */
      }
      record(
        `${label}.tool.empty_id_lists_checkpoint`,
        listDoc.ok === false &&
          Array.isArray(listDoc.available_checkpoints) &&
          listDoc.available_checkpoints[0]?.id === result?.checkpointId,
        listRaw.replace(/\s+/g, ' ').slice(0, 300),
      );
      record(
        `${label}.tool.listing_changed_nothing`,
        read(staged.workspace, 'new.ts') !== null && read(staged.workspace, 'old.ts') === null,
      );
      raw = await runTool('rb1', {
        checkpoint_id: listDoc.available_checkpoints?.[0]?.id ?? '',
        confirm: true,
        ...(rejectPaths ? { paths: rejectPaths } : {}),
      });
      doc = JSON.parse(raw);
    } else {
      // Same call the POST /workspace/checkpoint/rollback route makes (dispatch.ts).
      raw = mods.checkpoint.rollbackWorkspaceCheckpoint(
        staged.workspace,
        staged.cqrRoot,
        String(result?.checkpointId || ''),
        { sessionKey: sessionId, confirm: true, guard: { allowNas: false }, paths: rejectPaths },
      );
      doc = JSON.parse(raw);
    }
    record(`${label}.reject.ok`, doc.ok === true, raw.slice(0, 400));
    return { staged, doc, mock };
  } catch (e) {
    record(`${label}.threw`, false, e?.stack || String(e));
    mock.server.close();
    cleanup(staged.cqrRoot);
    return null;
  }
}

/** The core keeps handles under cqrRoot open while this process lives (EPERM on Windows). */
const leftoverDirs = [];
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    leftoverDirs.push(dir);
  }
}

function cleanupAfterExit() {
  if (!leftoverDirs.length) return;
  const script =
    "setTimeout(()=>{for(const d of JSON.parse(process.argv[1])){try{require('fs').rmSync(d,{recursive:true,force:true,maxRetries:5,retryDelay:300})}catch{}}},1500)";
  spawn(process.execPath, ['-e', script, JSON.stringify(leftoverDirs)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

function finish(run) {
  run.mock.server.close();
  cleanup(run.staged.cqrRoot);
}

async function main() {
  if (!existsSync(join(productRoot, 'core', 'dist', 'agent', 'code-agent.js'))) {
    console.error('core/dist missing — run tsc first');
    process.exit(1);
  }
  process.env.MY_AGENT_CODE_OWUI_PROTOCOL = 'api';
  const mods = {
    codeAgent: await import(dist('agent/code-agent.js')),
    providerStore: await import(dist('providers/provider-store.js')),
    checkpoint: await import(dist('agent/agent-checkpoint.js')),
    dispatch: await import(dist('routes/dispatch.js')),
    toolExecute: await import(dist('agent/agent-tool-execute.js')),
  };

  // 1) Reject everything the review pane lists.
  {
    const run = await runOnce('all', mods, (mutated) => mutated);
    if (run) {
      const ws = run.staged.workspace;
      record(
        'all.reject.originals_restored',
        Object.entries(ORIGINAL).every(([rel, body]) => read(ws, rel) === body),
        Object.keys(ORIGINAL).map((rel) => `${rel}=${read(ws, rel) === ORIGINAL[rel]}`).join(' '),
      );
      record(
        'all.reject.new_paths_removed',
        read(ws, 'new.ts') === null && read(ws, 'created.ts') === null && read(ws, 'moved-dst.ts') === null,
      );
      finish(run);
    }
  }

  // 2) Reject only the rename destination row.
  {
    const run = await runOnce('new_only', mods, () => ['new.ts']);
    if (run) {
      const ws = run.staged.workspace;
      record(
        'new_only.reject.rename_pair_restored',
        read(ws, 'old.ts') === ORIGINAL['old.ts'] && read(ws, 'new.ts') === null,
        `old=${JSON.stringify(read(ws, 'old.ts'))} new=${JSON.stringify(read(ws, 'new.ts'))}`,
      );
      record(
        'new_only.reject.unrelated_untouched',
        read(ws, 'a.ts')?.includes('a = 2') &&
          read(ws, 'b.ts')?.includes('b = 2') &&
          read(ws, 'created.ts') !== null &&
          read(ws, 'moved-dst.ts') !== null &&
          read(ws, 'moved-src.ts') === null,
      );
      record(
        'new_only.reject.paired_paths_reported',
        Array.isArray(run.doc.paired_paths) && run.doc.paired_paths.includes('old.ts'),
        JSON.stringify(run.doc.paired_paths),
      );
      finish(run);
    }
  }

  // 3) Reject only the apply_patch move source row.
  {
    const run = await runOnce('patch_src_only', mods, () => ['moved-src.ts']);
    if (run) {
      const ws = run.staged.workspace;
      record(
        'patch_src_only.reject.move_pair_restored',
        read(ws, 'moved-src.ts') === ORIGINAL['moved-src.ts'] && read(ws, 'moved-dst.ts') === null,
        `src=${JSON.stringify(read(ws, 'moved-src.ts'))} dst=${JSON.stringify(read(ws, 'moved-dst.ts'))}`,
      );
      finish(run);
    }
  }

  // 4) Decision-model approvals: the checkpoint is created by the reviewer branch.
  {
    const run = await runOnce('reviewer', mods, (mutated) => mutated, {
      reviewer: true,
      script: SCRIPT_REVIEWER,
      expectMutated: ['a.ts', 'b.ts', 'doomed.ts', 'new.ts', 'old.ts'],
      diskOk: (ws) =>
        read(ws, 'doomed.ts') === null &&
        read(ws, 'b.ts') === null &&
        read(ws, 'a.ts')?.includes('a = 2') &&
        read(ws, 'old.ts') === null &&
        read(ws, 'new.ts') !== null,
    });
    if (run) {
      const ws = run.staged.workspace;
      record(
        'reviewer.reject.originals_restored',
        Object.entries(ORIGINAL).every(([rel, body]) => read(ws, rel) === body),
        Object.keys(ORIGINAL).map((rel) => `${rel}=${read(ws, rel) === ORIGINAL[rel]}`).join(' '),
      );
      record('reviewer.reject.new_paths_removed', read(ws, 'new.ts') === null);
      finish(run);
    }
  }

  // 5) Same reject, sent over HTTP through the real route handler.
  {
    const run = await runOnce('http', mods, () => ['new.ts'], { http: true });
    if (run) {
      const ws = run.staged.workspace;
      record(
        'http.reject.rename_pair_restored',
        read(ws, 'old.ts') === ORIGINAL['old.ts'] && read(ws, 'new.ts') === null,
        `old=${JSON.stringify(read(ws, 'old.ts'))} new=${JSON.stringify(read(ws, 'new.ts'))}`,
      );
      record(
        'http.reject.response_fields',
        Array.isArray(run.doc.paired_paths) &&
          run.doc.paired_paths.includes('old.ts') &&
          Array.isArray(run.doc.deleted_paths) &&
          run.doc.deleted_paths.includes('new.ts') &&
          Array.isArray(run.doc.skipped_paths),
        `paired=${JSON.stringify(run.doc.paired_paths)} deleted=${JSON.stringify(run.doc.deleted_paths)} skipped=${JSON.stringify(run.doc.skipped_paths)}`,
      );
      finish(run);
    }
  }

  // 6) Agent tool, no paths: the whole run is undone, created files included.
  {
    const run = await runOnce('tool_full', mods, () => null, { tool: true });
    if (run) {
      const ws = run.staged.workspace;
      record(
        'tool_full.undo.originals_restored',
        Object.entries(ORIGINAL).every(([rel, body]) => read(ws, rel) === body),
        Object.keys(ORIGINAL).map((rel) => `${rel}=${read(ws, rel) === ORIGINAL[rel]}`).join(' '),
      );
      record(
        'tool_full.undo.created_paths_removed',
        read(ws, 'new.ts') === null && read(ws, 'created.ts') === null && read(ws, 'moved-dst.ts') === null,
        `deleted=${JSON.stringify(run.doc.deleted_paths)}`,
      );
      finish(run);
    }
  }

  // 7) Agent tool with paths: only that file is undone, its rename partner included.
  {
    const run = await runOnce('tool_paths', mods, () => ['new.ts'], { tool: true });
    if (run) {
      const ws = run.staged.workspace;
      record(
        'tool_paths.undo.rename_pair_restored',
        read(ws, 'old.ts') === ORIGINAL['old.ts'] && read(ws, 'new.ts') === null,
        `old=${JSON.stringify(read(ws, 'old.ts'))} new=${JSON.stringify(read(ws, 'new.ts'))}`,
      );
      record(
        'tool_paths.undo.unrelated_untouched',
        read(ws, 'a.ts')?.includes('a = 2') &&
          read(ws, 'b.ts')?.includes('b = 2') &&
          read(ws, 'created.ts') !== null &&
          read(ws, 'moved-dst.ts') !== null &&
          read(ws, 'moved-src.ts') === null,
      );
      finish(run);
    }
  }

  // 8) Legacy full restore (no paths, no removeCreated) still deletes nothing.
  {
    const run = await runOnce('legacy_full', mods, () => undefined);
    if (run) {
      const ws = run.staged.workspace;
      record(
        'legacy_full.restore_only',
        read(ws, 'old.ts') === ORIGINAL['old.ts'] &&
          read(ws, 'new.ts') !== null &&
          read(ws, 'created.ts') !== null &&
          run.doc.deleted === 0,
        `deleted=${run.doc.deleted}`,
      );
      finish(run);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `FAIL verify-mutate-reject-e2e (${failed.length})` : 'PASS verify-mutate-reject-e2e');
  cleanupAfterExit();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
