#!/usr/bin/env node
/**
 * Phase 1 parity gates (loop-friendly): terminal cancel, editor @ paths,
 * user MCP config load/save, checkpoint id plumbing symbols.
 * No live OWUI required.
 */
import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distOk = existsSync(path.join(repo, 'core', 'dist', 'agent', 'run-terminal.js'));

let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  OK   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('verify-parity-p1');

// --- static source contracts (always) ---
const srcChecks = [
  {
    name: 'run-terminal exports cancelTerminalJob',
    file: 'core/src/agent/run-terminal.ts',
    re: /export function cancelTerminalJob/,
  },
  {
    name: 'run_terminal uses AbortSignal + jobId',
    file: 'core/src/agent/agent-tool-execute.ts',
    re: /runTerminalCommandAsync[\s\S]*signal: ctx\?\.signal[\s\S]*jobId:/,
  },
  {
    name: 'editor_context supports paths[]',
    file: 'core/src/router/types.ts',
    re: /paths\?: string\[\]/,
  },
  {
    name: 'buildEditorContextSnippet lists @ paths',
    file: 'core/src/chat/editor-context.ts',
    re: /@ 컨텍스트 경로/,
  },
  {
    name: 'CodeAgentResult.checkpointId',
    file: 'core/src/agent/agent-run-types.ts',
    re: /checkpointId\?: string \| null/,
  },
  {
    name: 'SSE done may carry checkpointId',
    file: 'core/src/chat/chat-orchestrator.ts',
    re: /checkpointId/,
  },
  {
    name: 'dispatch rollback route',
    file: 'core/src/routes/dispatch.ts',
    re: /\/workspace\/checkpoint\/rollback/,
  },
  {
    name: 'dispatch mcp servers route',
    file: 'core/src/routes/dispatch.ts',
    re: /\/mcp\/servers/,
  },
  {
    name: 'dispatch terminal cancel route',
    file: 'core/src/routes/dispatch.ts',
    re: /\/fs\/run-terminal\/cancel/,
  },
  {
    name: 'user-mcp module exists',
    file: 'core/src/agent/user-mcp.ts',
    re: /loadUserMcpConfig/,
  },
  {
    name: 'UI Accept/Reject bar state',
    file: 'ui/workspace/src/store/workspaceStore.ts',
    re: /pendingMutateReview/,
  },
  {
    name: 'UI @ context paths',
    file: 'ui/workspace/src/store/workspaceStore.ts',
    re: /pendingContextPaths/,
  },
  {
    name: 'UI @ context picker',
    file: 'ui/workspace/src/components/ChatPane.tsx',
    re: /contextPickerOpen|context-at-button|@ 컨텍스트 추가/,
  },
    {
    name: 'UI mutate review path list',
    file: 'ui/workspace/src/components/MutateReviewPane.tsx',
    re: /mutate-review-bar/,
  },
  {
    name: 'dispatch mcp test route',
    file: 'core/src/routes/dispatch.ts',
    re: /\/mcp\/servers\/test/,
  },
  {
    name: 'partial rollback paths option',
    file: 'core/src/agent/agent-checkpoint.ts',
    re: /paths\?: string\[\]/,
  },
  {
    name: 'checkpoint previewDiff export',
    file: 'core/src/agent/agent-checkpoint.ts',
    re: /export function previewCheckpointDiff/,
  },
  {
    name: 'terminal cancel UI',
    file: 'ui/workspace/src/components/TerminalPane.tsx',
    re: /cancelTerminalCommand|terminal-cancel/,
  },
    {
    name: 'mutate reject selected',
    file: 'ui/workspace/src/components/MutateReviewPane.tsx',
    re: /mutate-review-reject-selected/,
  },
  {
    name: 'line hunk builder',
    file: 'core/src/agent/agent-checkpoint.ts',
    re: /buildLineDiffHunks/,
  },
  {
    name: 'listActiveTerminalJobs',
    file: 'core/src/agent/run-terminal.ts',
    re: /export function listActiveTerminalJobs/,
  },
  {
    name: 'terminal jobs UI',
    file: 'ui/workspace/src/components/TerminalPane.tsx',
    re: /terminal-active-jobs|listActiveRunTerminalJobs/,
  },
];

for (const c of srcChecks) {
  const p = path.join(repo, c.file);
  const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
  check(c.name, c.re.test(text), !existsSync(p) ? 'missing file' : 'pattern not found');
}

if (!distOk) {
  console.warn('  SKIP runtime dist checks (run npm run build first)');
  process.exit(failed ? 1 : 0);
}

const scratch = mkdtempSync(path.join(repo, 'data', 'outputs', 'verify-parity-p1-'));
try {
  // User MCP config load/save
  const {
    loadUserMcpConfig,
    saveUserMcpConfig,
    formatUserMcpServersJson,
  } = await import(pathToFileURL(path.join(repo, 'core', 'dist', 'agent', 'user-mcp.js')).href);

  const cfg0 = loadUserMcpConfig(scratch);
  check('empty mcp config', Array.isArray(cfg0.servers) && cfg0.servers.length === 0);

  saveUserMcpConfig(scratch, {
    version: 1,
    servers: [{ id: 'demo', command: 'npx', args: ['-y', 'noop'], enabled: false }],
  });
  const cfg1 = loadUserMcpConfig(scratch);
  check('mcp config round-trip', cfg1.servers.length === 1 && cfg1.servers[0].id === 'demo');
  const formatted = JSON.parse(formatUserMcpServersJson(scratch));
  check('formatUserMcpServersJson', formatted.ok === true && formatted.servers?.length === 1);

  // Terminal async cancel
  const {
    runTerminalCommandAsync,
    cancelTerminalJob,
    listActiveTerminalJobIds,
  } = await import(pathToFileURL(path.join(repo, 'core', 'dist', 'agent', 'run-terminal.js')).href);

  try {
    writeFileSync(path.join(scratch, 'marker.txt'), 'x\n');
    const jobId = `verify_${Date.now()}`;
    const pRun = runTerminalCommandAsync(scratch, 'Start-Sleep -Seconds 30', {
      timeoutMs: 60_000,
      jobId,
    });
    await new Promise((r) => setTimeout(r, 400));
    const activeBefore = listActiveTerminalJobIds();
    check('terminal job registered', activeBefore.includes(jobId), JSON.stringify(activeBefore));
    const killed = cancelTerminalJob(jobId);
    check('cancelTerminalJob returns true', killed === true);
    const result = await pRun;
    const cancelOk = result.cancelled === true || /cancel/i.test(result.stderr || '');
    check('async terminal cancelled', cancelOk, JSON.stringify(result).slice(0, 200));
  } catch (e) {
    check('async terminal cancel path', false, e instanceof Error ? e.message : String(e));
  }

  // Partial checkpoint rollback + preview
  const {
    createWorkspaceCheckpoint,
    rollbackWorkspaceCheckpoint,
    previewCheckpointDiff,
  } = await import(pathToFileURL(path.join(repo, 'core', 'dist', 'agent', 'agent-checkpoint.js')).href);
  mkdirSync(path.join(scratch, 'src'), { recursive: true });
  writeFileSync(path.join(scratch, 'src', 'a.ts'), 'const a = 1;\n', 'utf8');
  writeFileSync(path.join(scratch, 'src', 'b.ts'), 'const b = 1;\n', 'utf8');
  const ck = createWorkspaceCheckpoint(scratch, scratch, {
    sessionKey: 'parity-p1',
    label: 'partial',
    paths: ['src/a.ts', 'src/b.ts'],
  });
  writeFileSync(path.join(scratch, 'src', 'a.ts'), 'const a = 2;\n', 'utf8');
  writeFileSync(path.join(scratch, 'src', 'b.ts'), 'const b = 2;\n', 'utf8');
  const partialRaw = rollbackWorkspaceCheckpoint(scratch, scratch, ck.id, {
    sessionKey: 'parity-p1',
    confirm: true,
    paths: ['src/a.ts'],
  });
  const partialDoc = JSON.parse(partialRaw);
  check('partial rollback ok', partialDoc.ok === true && partialDoc.partial === true);
  check(
    'partial rollback only a.ts',
    readFileSync(path.join(scratch, 'src', 'a.ts'), 'utf8').includes('a = 1')
      && readFileSync(path.join(scratch, 'src', 'b.ts'), 'utf8').includes('b = 2'),
  );
  writeFileSync(path.join(scratch, 'src', 'new-only.ts'), 'export const n = 1;\n', 'utf8');
  const delRaw = rollbackWorkspaceCheckpoint(scratch, scratch, ck.id, {
    sessionKey: 'parity-p1',
    confirm: true,
    paths: ['src/new-only.ts'],
  });
  const delDoc = JSON.parse(delRaw);
  check('delete new file ok', delDoc.ok === true && (delDoc.deleted ?? 0) >= 1);
  check(
    'new file removed from disk',
    !existsSync(path.join(scratch, 'src', 'new-only.ts')),
  );
  const prevRaw = previewCheckpointDiff(scratch, scratch, ck.id, 'src/b.ts', {
    sessionKey: 'parity-p1',
  });
  const prevDoc = JSON.parse(prevRaw);
  check('preview diff changed for b', prevDoc.ok === true && prevDoc.changed === true);
  check(
    'preview has before/after',
    typeof prevDoc.before === 'string' && typeof prevDoc.after === 'string',
  );
  check(
    'preview has line hunks',
    Array.isArray(prevDoc.diff_lines) && prevDoc.diff_lines.length > 0,
  );
  check('preview +/− counters', (prevDoc.diff_added ?? 0) + (prevDoc.diff_removed ?? 0) > 0);

  // listActiveTerminalJobs shape
  const { listActiveTerminalJobs } = await import(
    pathToFileURL(path.join(repo, 'core', 'dist', 'agent', 'run-terminal.js')).href
  );
  check('listActiveTerminalJobs is array', Array.isArray(listActiveTerminalJobs()));

  // Editor context snippet
  const { buildEditorContextSnippet } = await import(
    pathToFileURL(path.join(repo, 'core', 'dist', 'chat', 'editor-context.js')).href
  );
  const snip = buildEditorContextSnippet({
    path: 'src/app.ts',
    paths: ['src/foo.ts', 'src/bar.ts'],
    selection: 'const x = 1;',
  });
  check('snippet includes primary path', snip.includes('src/app.ts'));
  check('snippet includes @ paths', snip.includes('@ 컨텍스트') && snip.includes('src/foo.ts'));
  const snipBuf = buildEditorContextSnippet({ path: 'buffer.ts' });
  check('synthetic buffer omitted', snipBuf === '');
} finally {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

if (failed) {
  console.error(`\nverify-parity-p1: ${failed} FAIL`);
  process.exit(1);
}
console.log('\nverify-parity-p1: GREEN');
