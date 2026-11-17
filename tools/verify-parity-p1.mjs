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
    extendWorkspaceCheckpoint,
    recordCheckpointMovePairs,
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
  // The run snapshots each target before its first mutation; a target that does not
  // exist yet is recorded as absent, which is what makes it deletable on reject.
  extendWorkspaceCheckpoint(scratch, scratch, ck.id, {
    sessionKey: 'parity-p1',
    paths: ['src/new-only.ts'],
  });
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

  // Reject must never delete a pre-existing file (data-loss regression).
  const rj = (rel) => path.join(scratch, 'rj', rel);
  const rjRead = (rel) => readFileSync(rj(rel), 'utf8');
  const rjReset = () => {
    rmSync(path.join(scratch, 'rj'), { recursive: true, force: true });
    mkdirSync(path.join(scratch, 'rj'), { recursive: true });
    writeFileSync(rj('a.ts'), 'a1\n', 'utf8');
    writeFileSync(rj('b.ts'), 'b1\n', 'utf8');
  };
  const rjRollback = (id, paths) => JSON.parse(
    rollbackWorkspaceCheckpoint(scratch, scratch, id, { sessionKey: 'parity-rj', confirm: true, paths }),
  );

  // Case 1: checkpoint holds only the first target; a later pre-existing file was never stored.
  rjReset();
  const c1 = createWorkspaceCheckpoint(scratch, scratch, { sessionKey: 'parity-rj', paths: ['rj/a.ts'] });
  writeFileSync(rj('a.ts'), 'a2\n', 'utf8');
  writeFileSync(rj('b.ts'), 'b2\n', 'utf8');
  const r1 = rjRollback(c1.id, ['rj/a.ts', 'rj/b.ts']);
  check('reject keeps unsnapshotted existing file', existsSync(rj('b.ts')) && rjRead('b.ts') === 'b2\n');
  check('reject restores snapshotted file', rjRead('a.ts') === 'a1\n');
  check(
    'reject reports unsnapshotted path as skipped',
    (r1.deleted ?? 0) === 0 && Array.isArray(r1.skipped_paths) && r1.skipped_paths.includes('rj/b.ts'),
    JSON.stringify(r1),
  );

  // Case 2: per-target snapshots land in one checkpoint, so every file is restorable.
  rjReset();
  const c2 = createWorkspaceCheckpoint(scratch, scratch, { sessionKey: 'parity-rj', paths: ['rj/a.ts'] });
  writeFileSync(rj('a.ts'), 'a2\n', 'utf8');
  const c2x = extendWorkspaceCheckpoint(scratch, scratch, c2.id, {
    sessionKey: 'parity-rj',
    paths: ['rj/b.ts', 'rj/new.ts', 'rj/a.ts'],
  });
  writeFileSync(rj('b.ts'), 'b2\n', 'utf8');
  writeFileSync(rj('new.ts'), 'n\n', 'utf8');
  check(
    'extend keeps one checkpoint id and records absent path',
    c2x?.id === c2.id && c2x.paths.includes('rj/b.ts') && (c2x.absentPaths ?? []).includes('rj/new.ts'),
    JSON.stringify(c2x),
  );
  const r2 = rjRollback(c2.id, ['rj/a.ts', 'rj/b.ts', 'rj/new.ts']);
  check(
    'reject restores both files (first state wins)',
    rjRead('a.ts') === 'a1\n' && rjRead('b.ts') === 'b1\n',
  );
  check('reject deletes only the new file', !existsSync(rj('new.ts')) && r2.deleted === 1, JSON.stringify(r2));
  check(
    'extend on a missing checkpoint returns null',
    extendWorkspaceCheckpoint(scratch, scratch, 'no-such-id', { sessionKey: 'parity-rj', paths: ['rj/a.ts'] }) === null,
  );

  // Case 3: a file over the snapshot size cap is not stored and must survive a reject.
  rjReset();
  writeFileSync(rj('big.bin'), Buffer.alloc(3_000_000, 1));
  const c3 = createWorkspaceCheckpoint(scratch, scratch, { sessionKey: 'parity-rj', paths: ['rj/big.bin'] });
  writeFileSync(rj('big.bin'), 'changed', 'utf8');
  const r3 = rjRollback(c3.id, ['rj/big.bin']);
  check(
    'oversize file recorded as skipped, not absent',
    c3.fileCount === 0 && (c3.skippedPaths ?? []).includes('rj/big.bin') && !(c3.absentPaths ?? []).includes('rj/big.bin'),
    JSON.stringify(c3),
  );
  check('reject keeps oversize existing file', existsSync(rj('big.bin')) && (r3.deleted ?? 0) === 0, JSON.stringify(r3));

  // Rename / move: the change-review list must carry both the old and the new path,
  // otherwise reject deletes the new path and never restores the old one (file lost).
  const { collectAutoCheckpointPaths, collectMutatedPathsForTool, collectMovePairsForTool } = await import(
    pathToFileURL(path.join(repo, 'core', 'dist', 'agent', 'agent-run-helpers.js')).href
  );
  const { renameWorkspaceFile, applyFilePatches, resolveApplyPatchArgs } = await import(
    pathToFileURL(path.join(repo, 'core', 'dist', 'agent', 'apply-patch.js')).href
  );
  const rn = (rel) => path.join(scratch, 'rn', rel);
  const rnHas = (rel) => existsSync(rn(rel));
  const rnRead = (rel) => readFileSync(rn(rel), 'utf8');
  // Same order as the run loop: snapshot targets -> execute -> record changed paths.
  const rnRun = () => {
    rmSync(path.join(scratch, 'rn'), { recursive: true, force: true });
    mkdirSync(path.join(scratch, 'rn'), { recursive: true });
    writeFileSync(rn('old.ts'), 'orig\n', 'utf8');
    let ckId = null;
    const mutated = new Set();
    return {
      rejectOnly(paths) {
        return JSON.parse(rollbackWorkspaceCheckpoint(scratch, scratch, ckId, {
          sessionKey: 'parity-rn',
          confirm: true,
          paths,
        }));
      },
      call(tool, args, exec) {
        const targets = collectAutoCheckpointPaths(tool, args, new Set());
        if (ckId) {
          extendWorkspaceCheckpoint(scratch, scratch, ckId, { sessionKey: 'parity-rn', paths: targets });
        } else {
          ckId = createWorkspaceCheckpoint(scratch, scratch, { sessionKey: 'parity-rn', paths: targets }).id;
        }
        exec();
        for (const p of collectMutatedPathsForTool(tool, args)) mutated.add(p);
        const moves = collectMovePairsForTool(tool, args);
        if (moves.length) recordCheckpointMovePairs(scratch, ckId, { sessionKey: 'parity-rn', moves });
      },
      reject() {
        return JSON.parse(rollbackWorkspaceCheckpoint(scratch, scratch, ckId, {
          sessionKey: 'parity-rn',
          confirm: true,
          paths: [...mutated],
        }));
      },
      mutated,
    };
  };
  const renameArgs = { path: 'rn/old.ts', new_path: 'rn/new.ts' };
  const doRename = () => renameWorkspaceFile(scratch, 'rn/old.ts', 'rn/new.ts');
  const rnBack = () => rnHas('old.ts') && rnRead('old.ts') === 'orig\n' && !rnHas('new.ts');

  check(
    'rename_file reports old and new path as changed',
    JSON.stringify(collectMutatedPathsForTool('rename_file', renameArgs)) === JSON.stringify(['rn/old.ts', 'rn/new.ts']),
  );

  // Case A: rename only.
  const ra = rnRun();
  ra.call('rename_file', renameArgs, doRename);
  const raDoc = ra.reject();
  check('reject undoes a plain rename', rnBack(), JSON.stringify(raDoc));

  // Case B: rename, then edit the new path (previously: file gone from both paths).
  const rb = rnRun();
  rb.call('rename_file', renameArgs, doRename);
  rb.call('write_file', { path: 'rn/new.ts' }, () => writeFileSync(rn('new.ts'), 'edited\n', 'utf8'));
  const rbDoc = rb.reject();
  check('reject after rename+edit restores the original file', rnBack(), JSON.stringify(rbDoc));

  // Case C: edit the old path, then rename (previously: edited copy left at the new path).
  const rc = rnRun();
  rc.call('write_file', { path: 'rn/old.ts' }, () => writeFileSync(rn('old.ts'), 'edited\n', 'utf8'));
  rc.call('rename_file', renameArgs, doRename);
  const rcDoc = rc.reject();
  check('reject after edit+rename leaves no copy at the new path', rnBack(), JSON.stringify(rcDoc));

  // apply_patch move, patch-text form and files[] form.
  const movePatch = { patch: '*** Begin Patch\n*** Update File: rn/old.ts\n*** Move to: rn/new.ts\n*** End Patch\n' };
  const moveFiles = { files: [{ path: 'rn/old.ts', action: 'move', new_path: 'rn/new.ts' }] };
  for (const [label, moveArgs] of [['patch text', movePatch], ['files[]', moveFiles]]) {
    const rm = rnRun();
    let moveResult = null;
    rm.call('apply_patch', moveArgs, () => {
      moveResult = applyFilePatches(scratch, resolveApplyPatchArgs(moveArgs));
    });
    check(`apply_patch move applied (${label})`, moveResult?.ok === true && rnHas('new.ts') && !rnHas('old.ts'), JSON.stringify(moveResult));
    check(
      `apply_patch move reports both paths (${label})`,
      rm.mutated.has('rn/old.ts') && rm.mutated.has('rn/new.ts'),
      JSON.stringify([...rm.mutated]),
    );
    rm.call('write_file', { path: 'rn/new.ts' }, () => writeFileSync(rn('new.ts'), 'edited\n', 'utf8'));
    const rmDoc = rm.reject();
    check(`reject undoes apply_patch move + edit (${label})`, rnBack(), JSON.stringify(rmDoc));
  }

  // Partial reject: a rename's two rows are one change. Rejecting only the new path
  // used to delete it without restoring the old path (file gone from the workspace).
  const pairJson = (tool, args) => JSON.stringify(collectMovePairsForTool(tool, args));
  const wantPair = JSON.stringify([{ from: 'rn/old.ts', to: 'rn/new.ts' }]);
  check('rename_file yields a move pair', pairJson('rename_file', renameArgs) === wantPair);
  check('apply_patch patch-text move yields a move pair', pairJson('apply_patch', movePatch) === wantPair);
  check('apply_patch files[] move yields a move pair', pairJson('apply_patch', moveFiles) === wantPair);
  check('plain edit yields no move pair', pairJson('write_file', { path: 'rn/old.ts' }) === '[]');

  const pn = rnRun();
  pn.call('rename_file', renameArgs, doRename);
  const pnDoc = pn.rejectOnly(['rn/new.ts']);
  check(
    'partial reject of the new path also restores the old path',
    rnBack() && (pnDoc.paired_paths ?? []).includes('rn/old.ts'),
    JSON.stringify(pnDoc),
  );

  const po = rnRun();
  po.call('rename_file', renameArgs, doRename);
  const poDoc = po.rejectOnly(['rn/old.ts']);
  check(
    'partial reject of the old path also removes the new path',
    rnBack() && (poDoc.paired_paths ?? []).includes('rn/new.ts'),
    JSON.stringify(poDoc),
  );

  const pe = rnRun();
  pe.call('rename_file', renameArgs, doRename);
  pe.call('write_file', { path: 'rn/new.ts' }, () => writeFileSync(rn('new.ts'), 'edited\n', 'utf8'));
  const peDoc = pe.rejectOnly(['rn/new.ts']);
  check('partial reject after rename+edit restores the original file', rnBack(), JSON.stringify(peDoc));

  // Chain old -> new -> third: rejecting the last path walks back to the first.
  const pc = rnRun();
  pc.call('rename_file', renameArgs, doRename);
  pc.call('rename_file', { path: 'rn/new.ts', new_path: 'rn/third.ts' }, () =>
    renameWorkspaceFile(scratch, 'rn/new.ts', 'rn/third.ts'));
  const pcDoc = pc.rejectOnly(['rn/third.ts']);
  check('partial reject walks a rename chain back', rnBack() && !rnHas('third.ts'), JSON.stringify(pcDoc));

  // apply_patch move, patch-text form: same pairing.
  const pm = rnRun();
  pm.call('apply_patch', movePatch, () => applyFilePatches(scratch, resolveApplyPatchArgs(movePatch)));
  const pmDoc = pm.rejectOnly(['rn/new.ts']);
  check('partial reject of an apply_patch move restores the old path', rnBack(), JSON.stringify(pmDoc));

  // An unrelated file in the same run is not dragged along by the pairing.
  const pu = rnRun();
  writeFileSync(rn('other.ts'), 'other-orig\n', 'utf8');
  pu.call('write_file', { path: 'rn/other.ts' }, () => writeFileSync(rn('other.ts'), 'other-edited\n', 'utf8'));
  pu.call('rename_file', renameArgs, doRename);
  const puDoc = pu.rejectOnly(['rn/new.ts']);
  check(
    'partial reject of a rename leaves unrelated edits alone',
    rnBack() && rnRead('other.ts') === 'other-edited\n' && (puDoc.paired_paths ?? []).length === 1,
    JSON.stringify(puDoc),
  );

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
