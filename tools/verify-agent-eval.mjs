/**
 * Agent eval suite (ADR-003 D): fixture scenarios → success / guardrail metrics.
 * Does not call live LLMs — measures tool pipeline + guards.
 *
 * Usage: node tools/verify-agent-eval.mjs
 */
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cqrRoot = path.resolve(__dirname, '..');
const evalRoot = path.join(cqrRoot, 'data', '_agent_eval');

const results = [];

function record(id, ok, detail = '') {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
}

function pathToFileUrl(p) {
  return pathToFileURL(p).href;
}

async function main() {
  // Ensure dist is fresh enough for new modules
  const toolsJs = path.join(cqrRoot, 'core/dist/agent/tools.js');
  if (!existsSync(toolsJs)) {
    console.error('FAIL: core/dist missing — run npm run build first');
    process.exit(1);
  }

  if (existsSync(evalRoot)) rmSync(evalRoot, { recursive: true, force: true });
  mkdirSync(evalRoot, { recursive: true });

  const {
    executeAgentTool,
    normalizeToolCall,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/tools.js')));
  const { createDefaultAgentHooks, isHookStop } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-hooks.js'))
  );
  const { createWorkspaceCheckpoint, rollbackWorkspaceCheckpoint } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-checkpoint.js'))
  );
  const { appendAgentAuditEvent, loadAuditShipPolicy } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-audit-ledger.js'))
  );
  const { runWorkspaceDiagnostics, detectDiagnostics } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/run-diagnostics.js'))
  );
  const {
    formatSilentVerifyRepairPrompt,
    isMutatingAgentTool,
    buildVerifyWitness,
    recordVerifyWitness,
    exhaustVerifyWitness,
  } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/verify-loop.js'))
  );
  const { buildRepoMap, formatRepoMap, extractImportEdges } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/repo-map.js'))
  );

  // --- Fixture: TS project with type error ---
  const fixTs = path.join(evalRoot, 'fix-ts');
  mkdirSync(fixTs, { recursive: true });
  writeFileSync(
    path.join(fixTs, 'package.json'),
    JSON.stringify({ name: 'eval-fix-ts', private: true, type: 'module' }, null, 2),
  );
  writeFileSync(
    path.join(fixTs, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['*.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(fixTs, 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\nconst x: number = "bad";\n',
  );

  // 1) diagnostics detect
  const detected = detectDiagnostics(fixTs);
  record(
    'diagnostics.detect',
    detected.kind === 'tsc' && Boolean(detected.command),
    detected.reason,
  );

  // 2) diagnostics fail on bad types (best-effort — npx tsc may use repo typescript)
  const diagOut = runWorkspaceDiagnostics(fixTs);
  let diagOk = false;
  try {
    const doc = JSON.parse(diagOut);
    diagOk = doc.ok === false || doc.skipped === true;
    record(
      'diagnostics.run_reports_failure_or_skip',
      diagOk,
      `ok=${doc.ok} skipped=${doc.skipped} exit=${doc.exit_code}`,
    );
  } catch (e) {
    record('diagnostics.run_reports_failure_or_skip', false, String(e));
  }

  // 3) checkpoint + rollback
  writeFileSync(path.join(fixTs, 'note.txt'), 'v1\n');
  const meta = createWorkspaceCheckpoint(fixTs, cqrRoot, {
    sessionKey: 'eval',
    label: 'eval-v1',
    paths: ['note.txt', 'math.ts'],
  });
  writeFileSync(path.join(fixTs, 'note.txt'), 'v2-corrupted\n');
  const rb = rollbackWorkspaceCheckpoint(fixTs, cqrRoot, meta.id, {
    sessionKey: 'eval',
    confirm: true,
  });
  const rbDoc = JSON.parse(rb);
  const restored = readFileSync(path.join(fixTs, 'note.txt'), 'utf8');
  record(
    'checkpoint.rollback',
    rbDoc.ok === true && restored.trim() === 'v1',
    `restored=${JSON.stringify(restored.trim())}`,
  );

  // 4) rollback without confirm denied
  const deny = JSON.parse(
    rollbackWorkspaceCheckpoint(fixTs, cqrRoot, meta.id, {
      sessionKey: 'eval',
      confirm: false,
    }),
  );
  record('checkpoint.rollback_requires_confirm', deny.ok === false);

  // 5) tool surface: run_diagnostics via executeAgentTool
  const toolDiag = await executeAgentTool(
    fixTs,
    normalizeToolCall({
      id: 'd1',
      type: 'function',
      function: { name: 'run_diagnostics', arguments: '{}' },
    }),
    {},
    { cqrRoot, sessionId: 'eval' },
  );
  record('tool.run_diagnostics', Boolean(toolDiag.output), toolDiag.label);

  // 6) workspace_checkpoint tool
  const toolCp = await executeAgentTool(
    fixTs,
    normalizeToolCall({
      id: 'c1',
      type: 'function',
      function: {
        name: 'workspace_checkpoint',
        arguments: JSON.stringify({ label: 'tool', paths: ['note.txt'] }),
      },
    }),
    {},
    { cqrRoot, sessionId: 'eval' },
  );
  let cpId = '';
  try {
    cpId = JSON.parse(toolCp.output).id;
    record('tool.workspace_checkpoint', Boolean(cpId), cpId);
  } catch {
    record('tool.workspace_checkpoint', false, toolCp.output.slice(0, 200));
  }

  // 7) guardrail: private key in tool args
  const hooks = createDefaultAgentHooks();
  const blocked = await hooks.beforeTool?.({
    tool: 'write_file',
    args: { path: 'x.pem', content: '-----BEGIN RSA PRIVATE KEY-----\nMII\n' },
    step: 1,
  });
  record('guardrail.block_private_key_args', isHookStop(blocked), blocked?.reason ?? '');

  // 8) verify-loop helpers
  record('verify.is_mutating', isMutatingAgentTool('edit_file') && !isMutatingAgentTool('read_file'));
  const prompt = formatSilentVerifyRepairPrompt('diagnostics', {
    command: 'tsc',
    output: 'error TS2322',
    attempt: 1,
    maxAttempts: 2,
    mutatedPaths: ['a.ts'],
  });
  record(
    'verify.repair_prompt',
    prompt.includes('INTERNAL_VERIFY_FAILED') && prompt.includes('mutated: a.ts'),
  );
  const passW = buildVerifyWitness({
    kind: 'diagnostics',
    diag: { ok: true, command: 'tsc' },
    atStep: 1,
  });
  record('verify.witness_pass', passW?.ok === true && passW.exitCode === 0);
  const weakW = buildVerifyWitness({
    kind: 'diagnostics',
    diag: { ok: true, weak: true, command: 'node --check' },
    atStep: 2,
  });
  record('verify.witness_weak_not_strong', weakW?.ok === false);
  const sink = { verifyWitness: null, ranVerifyCommand: false };
  recordVerifyWitness(sink, {
    kind: 'diagnostics',
    diag: { ok: true, command: 'tsc' },
    atStep: 3,
  });
  record(
    'verify.record_witness',
    sink.ranVerifyCommand === true && sink.verifyWitness?.ok === true,
  );
  record('verify.exhaust_witness', exhaustVerifyWitness(9).ok === false);

  // 9) audit ledger
  const ev = appendAgentAuditEvent(cqrRoot, {
    type: 'tool_end',
    sessionId: 'eval',
    tool: 'run_diagnostics',
    ok: false,
  });
  const ledger = path.join(cqrRoot, 'data', 'audit', 'agent-ledger.jsonl');
  const ledgerOk = existsSync(ledger) && readFileSync(ledger, 'utf8').includes(ev.id);
  record('audit.ledger_append', ledgerOk, ev.id);
  const policy = loadAuditShipPolicy(cqrRoot);
  record('audit.ship_default_off', policy.enabled === false);

  // 10) repo map import edges
  writeFileSync(
    path.join(fixTs, 'main.ts'),
    "import { add } from './math.js';\nexport const n = add(1, 2);\n",
  );
  const edges = extractImportEdges('main.ts', readFileSync(path.join(fixTs, 'main.ts'), 'utf8'));
  record('repomap.import_edges', edges.some((e) => e.includes('./math')), edges.join('; '));
  const maps = buildRepoMap(fixTs, { maxFiles: 20 });
  const formatted = formatRepoMap(maps, 4000);
  record('repomap.build', /math\.ts|function add|imports:/i.test(formatted), formatted.slice(0, 120));

  // 11) grounding 1/2/3/4/5/6 (no live LLM)
  const {
    contentClaimsUngroundedFileState,
    expectedPathsForUiRequest,
    mutationsCoverExpected,
    needsUiClarifyQuestion,
    pathsFromUiClarifyReply,
    loadUiFacts,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-grounding.js')));
  const {
    parseUiVisionTarget,
    classifyUiTargetFromMessage,
    visionTargetToBootstrapPath,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-ui-vision.js')));

  const facts = loadUiFacts(cqrRoot);
  record('grounding.ui_facts_loaded', Boolean(facts?.shell?.custom_caption), facts?.shell?.title ?? '');
  record(
    'grounding.ungrounded_detect',
    contentClaimsUngroundedFileState(
      '현재 MainWindow는 기본 Windows 타이틀바라 Title만 가능. Title="MY Agent"',
    ),
  );
  const exp = expectedPathsForUiRequest('위에 바 MY Agent', facts);
  record('grounding.expected_titlebar', exp.some((p) => /MainWindow/i.test(p)), exp[0] ?? '');
  record(
    'grounding.done_reject_chatpane',
    !mutationsCoverExpected(['ui/workspace/src/components/ChatPane.tsx'], exp).ok,
  );
  record(
    'grounding.vision_parse',
    parseUiVisionTarget('{"target":"confirm","reason":"삭제할까요"}')?.target === 'confirm',
  );
  record(
    'grounding.vision_path',
    /MainWindow|ConfirmModal|ChatPane/i.test(
      visionTargetToBootstrapPath('title_bar', facts?.targets) ?? '',
    ),
  );
  record(
    'grounding.clarify_needed',
    needsUiClarifyQuestion('이 두 부분 색 맞춰줘', 'unknown') === true,
  );
  record(
    'grounding.clarify_skip_screenshot',
    needsUiClarifyQuestion('색상 통일', 'unknown', { hasScreenshot: true }) === false,
  );
  record(
    'grounding.clarify_skip_annae',
    needsUiClarifyQuestion('안내창 색상 통일', 'unknown') === false,
  );
  record(
    'grounding.clarify_reply_1',
    pathsFromUiClarifyReply('1', facts).some((p) => /MainWindow/i.test(p)),
  );
  record(
    'grounding.message_heuristic',
    classifyUiTargetFromMessage('위에 바').target === 'title_bar',
  );

  // 14) product memory E
  const {
    loadProductFacts,
    loadAgentsMd,
    formatProductMemoryForPrompt,
    productFactsHasRoute,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-product-memory.js')));
  const productFacts = loadProductFacts(cqrRoot);
  record(
    'product.facts_loaded',
    Boolean(productFacts?.api?.route_count && productFacts.api.route_count > 10),
    `routes=${productFacts?.api?.route_count ?? 0}`,
  );
  record(
    'product.layout_workspace',
    productFacts?.layout?.primary_ui === 'ui/workspace',
  );
  record(
    'product.has_chat_route',
    productFactsHasRoute(productFacts, 'POST', '/chat')
      || (productFacts?.api?.routes ?? []).some((r) => r.path.includes('/chat')),
  );
  const agentsMd = loadAgentsMd(cqrRoot);
  record('product.agents_md', /Primary UI|ui\/workspace/i.test(agentsMd));
  record(
    'product.prompt_block',
    formatProductMemoryForPrompt(productFacts, agentsMd).includes('Product memory'),
  );

  // 15) audit observability G
  const { summarizeAgentAuditLedger, formatAuditSummaryBrief } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-audit-ledger.js'))
  );
  appendAgentAuditEvent(cqrRoot, {
    type: 'guard_block',
    sessionId: 'eval',
    detail: 'work_mode_locked',
    tool: 'edit_file',
  });
  appendAgentAuditEvent(cqrRoot, {
    type: 'work_mode',
    sessionId: 'eval',
    detail: 'plan:locked',
  });
  const auditSum = summarizeAgentAuditLedger(cqrRoot, { maxLines: 500 });
  record('audit.summary_total', auditSum.total > 0, `total=${auditSum.total}`);
  record('audit.summary_guards', auditSum.guard_blocks >= 1);
  record(
    'audit.summary_brief',
    formatAuditSummaryBrief(auditSum).includes('agent_audit'),
  );

  // 16) extra grounding matrix
  record(
    'grounding.done_accept_titlebar',
    mutationsCoverExpected(['shell/CqrPa.Shell/MainWindow.xaml'], exp).ok === true,
  );
  record(
    'grounding.ungrounded_reject_short',
    contentClaimsUngroundedFileState('ok') === false,
  );
  record(
    'grounding.composer_paths',
    expectedPathsForUiRequest('입력창 고쳐줘', facts).some((p) => /ChatPane/i.test(p)),
  );
  record(
    'grounding.confirm_paths',
    expectedPathsForUiRequest('삭제할까요 모달', facts).some((p) => /Confirm/i.test(p)),
  );
  record(
    'grounding.vision_composer',
    parseUiVisionTarget('{"target":"composer","reason":"input"}')?.target === 'composer',
  );
  record(
    'grounding.message_confirm',
    classifyUiTargetFromMessage('삭제할까요 확인창').target === 'confirm',
  );
  // 17) workspace index A + multimodal B
  const {
    indexQueryCandidatesFromMessage,
    buildQuerySearchContext,
    enrichWorkspaceIndexContext,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-workspace-index.js')));
  const {
    messageLooksErrorish,
    buildCodeAgentUserContent,
    formatMultimodalSystemNote,
    seedDiagnosticsContext,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-multimodal.js')));

  writeFileSync(
    path.join(fixTs, 'broken.ts'),
    'export const boom = (): number => "x";\n',
  );
  const qCandidates = indexQueryCandidatesFromMessage('TS2322 broken.ts 고쳐줘');
  record('index.query_candidates', qCandidates.some((q) => /broken|TS2322/i.test(q)), qCandidates.join(','));
  const qHits = buildQuerySearchContext(fixTs, 'broken.ts TypeError');
  record('index.query_hits', /broken\.ts|Query search/i.test(qHits), qHits.slice(0, 80));
  const enriched = enrichWorkspaceIndexContext(fixTs, '## stub tree', 'broken.ts', {
    repoMapMaxChars: 2_000,
    queryMaxChars: 2_000,
  });
  record(
    'index.enrich_has_map_or_hits',
    /Repository map|Query search|broken/i.test(enriched),
  );
  record('multimodal.errorish', messageLooksErrorish('TypeError: x is not a function'));
  record(
    'multimodal.user_parts',
    Array.isArray(
      buildCodeAgentUserContent('봐줘', undefined, ['data:image/png;base64,aaa']),
    ),
  );
  record(
    'multimodal.system_note',
    formatMultimodalSystemNote(true, true, true).includes('Multimodal'),
  );
  const seeded = seedDiagnosticsContext(
    fixTs,
    'error TS2322',
    '### err.log\nerror TS2322: Type string is not assignable',
  );
  record('multimodal.seed_uses_attachment', /Attachment log|Seeded diagnostics/i.test(seeded));

  // 18) repo-map TTL cache + query_repo_map
  const {
    getOrBuildRepoMap,
    queryRepoMap,
    invalidateRepoMapCache,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/repo-map.js')));
  invalidateRepoMapCache(fixTs);
  const map1 = getOrBuildRepoMap(fixTs, { focusTokens: ['add'] });
  const map2 = getOrBuildRepoMap(fixTs, { focusTokens: ['add'] });
  record(
    'repomap.ttl_reuse',
    map1.length > 0 && map2.length > 0 && map1[0].path === map2[0].path,
    `n=${map1.length}`,
  );
  const symHits = queryRepoMap(fixTs, 'add', { kind: 'function', maxResults: 10 });
  record(
    'repomap.query_symbol',
    symHits.some((h) => /math\.ts/i.test(h.path) && h.symbols.some((s) => s.name === 'add')),
    JSON.stringify(symHits.slice(0, 1)),
  );
  // façade-only re-export file must be indexed + multi-token query must hit
  writeFileSync(
    path.join(fixTs, 'tools.ts'),
    "export { CODE_AGENT_TOOLS } from './agent-tool-definitions.js';\n",
    'utf8',
  );
  writeFileSync(
    path.join(fixTs, 'agent-tool-definitions.ts'),
    'export const CODE_AGENT_TOOLS = [];\n',
    'utf8',
  );
  invalidateRepoMapCache(fixTs);
  const facadeHits = queryRepoMap(fixTs, 'tools.ts agent-tool-definitions', { maxResults: 10 });
  record(
    'repomap.query_facade_multitoken',
    facadeHits.some((h) => /tools\.ts$/i.test(h.path)),
    JSON.stringify(facadeHits.map((h) => h.path).slice(0, 5)),
  );
  const toolMap = await executeAgentTool(
    fixTs,
    normalizeToolCall({
      id: 'qm1',
      type: 'function',
      function: {
        name: 'query_repo_map',
        arguments: JSON.stringify({ query: 'add', kind: 'function' }),
      },
    }),
    {},
    { cqrRoot, sessionId: 'eval' },
  );
  record(
    'tool.query_repo_map',
    /"count"\s*:\s*[1-9]/.test(toolMap.output) && /add/i.test(toolMap.output),
    toolMap.output.slice(0, 120),
  );

  // 19) symbol windows + incremental repo-map + atomic apply_patch + planner
  const { buildSymbolChunkContext, collectSymbolChunks } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-symbol-chunks.js'))
  );
  const { repoMapCacheStats } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/repo-map.js'))
  );
  const { applyFilePatches } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/apply-patch.js'))
  );
  const {
    formatAgenticLoopSystemNote,
    formatPatchFormatConstraints,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-planner.js')));

  writeFileSync(
    path.join(fixTs, 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  );
  invalidateRepoMapCache(fixTs);
  getOrBuildRepoMap(fixTs, {});
  const fpBefore = repoMapCacheStats(fixTs).fileCount;
  // touch only math.ts → dirty rebuild should keep fingerprints
  writeFileSync(
    path.join(fixTs, 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n',
  );
  invalidateRepoMapCache(fixTs);
  const mapDirty = getOrBuildRepoMap(fixTs, { focusTokens: ['add'] });
  record(
    'repomap.incremental_dirty',
    mapDirty.some((m) => /math\.ts/i.test(m.path)) && repoMapCacheStats(fixTs).fileCount >= fpBefore,
    `files=${repoMapCacheStats(fixTs).fileCount}`,
  );

  const chunks = collectSymbolChunks(fixTs, 'add function in math.ts');
  record(
    'symbol.chunks_collect',
    chunks.some((c) => /math\.ts/i.test(c.path) && /add/i.test(c.name) && /return/.test(c.body)),
    JSON.stringify(chunks.slice(0, 1).map((c) => ({ path: c.path, name: c.name }))),
  );
  const chunkCtx = buildSymbolChunkContext(fixTs, 'add math.ts', { maxChars: 3_000 });
  record('symbol.chunk_context', /Adjacent code|symbol windows/i.test(chunkCtx));

  const enriched2 = enrichWorkspaceIndexContext(fixTs, '', 'add math.ts', {
    repoMapMaxChars: 2_000,
    queryMaxChars: 1_500,
    symbolMaxChars: 2_500,
  });
  record(
    'index.enrich_symbol_windows',
    /Adjacent code|Repository map/i.test(enriched2),
    enriched2.slice(0, 100),
  );

  writeFileSync(path.join(fixTs, 'a.ts'), 'export const A = 1;\n');
  writeFileSync(path.join(fixTs, 'b.ts'), 'export const B = 1;\n');
  const atomicFail = applyFilePatches(fixTs, [
    { path: 'a.ts', edits: [{ old_text: 'export const A = 1;', new_text: 'export const A = 2;' }] },
    { path: 'b.ts', edits: [{ old_text: 'DOES_NOT_EXIST', new_text: 'x' }] },
  ]);
  const aAfterFail = readFileSync(path.join(fixTs, 'a.ts'), 'utf8');
  record(
    'patch.atomic_abort',
    atomicFail.ok === false
      && /ATOMIC_ABORT/.test(atomicFail.errors.join('\n'))
      && aAfterFail.includes('A = 1'),
    atomicFail.errors.join('; '),
  );
  const atomicOk = applyFilePatches(fixTs, [
    { path: 'a.ts', edits: [{ old_text: 'export const A = 1;', new_text: 'export const A = 2;' }] },
    { path: 'b.ts', edits: [{ old_text: 'export const B = 1;', new_text: 'export const B = 2;' }] },
  ]);
  record(
    'patch.atomic_commit',
    atomicOk.ok
      && readFileSync(path.join(fixTs, 'a.ts'), 'utf8').includes('A = 2')
      && readFileSync(path.join(fixTs, 'b.ts'), 'utf8').includes('B = 2'),
  );

  record(
    'planner.loop_note',
    /Planner|Executor|Verify/i.test(formatAgenticLoopSystemNote())
      && /Self-check|충족\/부분\/미충족/.test(formatAgenticLoopSystemNote()),
  );
  record(
    'planner.format_constraints',
    /Format constraints|Begin Patch|atomic/i.test(formatPatchFormatConstraints()),
  );

  // 20) ADR-003 A2 embedding pilot — persist + paraphrase gain vs FTS
  const {
    ensureEmbeddingIndex,
    searchEmbeddingIndex,
    invalidateEmbeddingIndex,
    hybridRankPaths,
    embeddingIndexDir,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-embedding-index.js')));
  const { searchWorkspaceFilesAdvanced } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/workspace-search.js'))
  );

  const embedFix = path.join(evalRoot, 'embed-fix');
  mkdirSync(embedFix, { recursive: true });
  // No shared paraphrase tokens in body — only synonym expansion should bridge.
  writeFileSync(
    path.join(embedFix, 'calc.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  );
  writeFileSync(
    path.join(embedFix, 'noise.ts'),
    'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n',
  );

  invalidateEmbeddingIndex(embedFix);
  const {
    embeddingSqlitePath,
    resolveEmbeddingStoreKind,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-embedding-index.js')));
  const prevStore = process.env.MY_AGENT_EMBED_STORE;
  process.env.MY_AGENT_EMBED_STORE = 'sqlite';
  const idx1 = ensureEmbeddingIndex(embedFix, { cqrRoot, force: true });
  record('embed.index_build', Boolean(idx1 && idx1.chunks.length >= 2), `chunks=${idx1?.chunks.length}`);
  const embDir = embeddingIndexDir(cqrRoot);
  const sqlitePath = embeddingSqlitePath(cqrRoot, embedFix, 'local');
  record(
    'embed.sqlite_persist',
    resolveEmbeddingStoreKind() === 'sqlite' && existsSync(sqlitePath),
    sqlitePath,
  );
  const diskFiles = existsSync(embDir)
    ? readdirSync(embDir).filter((f) => f.endsWith('.json') || f.endsWith('.sqlite'))
    : [];
  record('embed.persist_file', diskFiles.length >= 1, diskFiles.join(','));

  invalidateEmbeddingIndex(embedFix);
  const idx2 = ensureEmbeddingIndex(embedFix, { cqrRoot });
  record(
    'embed.persist_reload',
    Boolean(idx2 && idx2.chunks.length === idx1.chunks.length),
    `n=${idx2?.chunks.length}`,
  );
  if (prevStore === undefined) delete process.env.MY_AGENT_EMBED_STORE;
  else process.env.MY_AGENT_EMBED_STORE = prevStore;

  writeFileSync(
    path.join(embedFix, 'calc.ts'),
    'export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n',
  );
  invalidateEmbeddingIndex(embedFix);
  const idx3 = ensureEmbeddingIndex(embedFix, { cqrRoot });
  const calcChunk = idx3?.chunks.find((c) => /calc\.ts/i.test(c.path));
  record(
    'embed.incremental_dirty',
    Boolean(calcChunk && /a \+ b \+ 0/.test(calcChunk.preview)),
    calcChunk?.preview?.slice(0, 80),
  );

  const {
    embeddingPathPriority,
    embedMaxFiles,
    embeddingPathScoreBoost,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-embedding-index.js')));
  record(
    'embed.path_priority_src',
    embeddingPathPriority('core/src/agent/tools.ts') < embeddingPathPriority('tests/fixtures/x.ts'),
    `src=${embeddingPathPriority('core/src/agent/tools.ts')} test=${embeddingPathPriority('tests/fixtures/x.ts')}`,
  );
  record(
    'embed.max_files_default',
    embedMaxFiles({}) >= 800,
    `maxFiles=${embedMaxFiles({})}`,
  );
  record(
    'embed.path_boost_src',
    embeddingPathScoreBoost('src/app.ts') > embeddingPathScoreBoost('tests/a.ts'),
    `boost src=${embeddingPathScoreBoost('src/app.ts')} test=${embeddingPathScoreBoost('tests/a.ts')}`,
  );

  const paraphrase = 'summation of integers total';
  const ftsHits = searchWorkspaceFilesAdvanced(embedFix, paraphrase, { maxHits: 8 });
  const ftsHitCalc = ftsHits.some((h) => /calc\.ts/i.test(h.path));
  const embHits = searchEmbeddingIndex(embedFix, paraphrase, { maxHits: 8, cqrRoot });
  const embHitCalc = embHits.some((h) => /calc\.ts/i.test(h.path));
  record('embed.retrieve_paraphrase', embHitCalc, JSON.stringify(embHits.slice(0, 2)));
  record(
    'embed.gain_vs_fts',
    embHitCalc && !ftsHitCalc,
    `fts=${ftsHitCalc} emb=${embHitCalc}`,
  );
  const hybrid = hybridRankPaths(
    ftsHits.map((h) => h.path),
    embHits,
  );
  record(
    'embed.hybrid_rrf',
    hybrid.some((h) => /calc\.ts/i.test(h.path)),
    JSON.stringify(hybrid.slice(0, 3)),
  );

  const toolEmbed = await executeAgentTool(
    embedFix,
    normalizeToolCall({
      id: 'em1',
      type: 'function',
      function: {
        name: 'search_embeddings',
        arguments: JSON.stringify({ query: paraphrase }),
      },
    }),
    {},
    { cqrRoot, sessionId: 'eval' },
  );
  record(
    'tool.search_embeddings',
    /calc\.ts/i.test(toolEmbed.output) && /local-hashed-tf/.test(toolEmbed.output),
    toolEmbed.output.slice(0, 140),
  );

  const enrichedEmb = enrichWorkspaceIndexContext(embedFix, '', paraphrase, {
    repoMapMaxChars: 1_500,
    queryMaxChars: 1_000,
    embeddingMaxChars: 2_000,
    cqrRoot,
  });
  record(
    'index.enrich_embeddings',
    /Embedding retrieval/i.test(enrichedEmb),
    enrichedEmb.slice(0, 120),
  );

  // 21) cloud embeddings option (stub: key — no network)
  const {
    searchEmbeddingIndexAsync,
    ensureCloudEmbeddingIndex,
    resolveEmbeddingMode,
    setCloudEmbedBatchForTests,
  } = await import(pathToFileUrl(path.join(cqrRoot, 'core/dist/agent/agent-embedding-index.js')));
  const { stubEmbeddingVector, createEmbeddings } = await import(
    pathToFileUrl(path.join(cqrRoot, 'core/dist/providers/embeddings.js'))
  );

  const prevEmb = process.env.MY_AGENT_EMBEDDINGS;
  const prevKey = process.env.MY_AGENT_EMBEDDINGS_API_KEY;
  const prevUrl = process.env.MY_AGENT_EMBEDDINGS_BASE_URL;
  const prevModel = process.env.MY_AGENT_EMBEDDINGS_MODEL;
  try {
    process.env.MY_AGENT_EMBEDDINGS = 'cloud';
    process.env.MY_AGENT_EMBEDDINGS_API_KEY = 'stub:eval';
    process.env.MY_AGENT_EMBEDDINGS_MODEL = 'stub-embed';
    delete process.env.MY_AGENT_EMBEDDINGS_BASE_URL;

    record('embed.mode_cloud', resolveEmbeddingMode() === 'cloud');
    const stubVec = stubEmbeddingVector('hello add number', 64);
    record('embed.stub_vector_dim', stubVec.length === 64 && Math.abs(stubVec.reduce((a, b) => a + b * b, 0) - 1) < 1e-6);

    const created = await createEmbeddings('http://127.0.0.1/stub', 'stub:x', 'm', ['a', 'b']);
    record(
      'embed.create_stub_batch',
      created.engine === 'stub' && created.vectors.length === 2,
      created.engine,
    );

    invalidateEmbeddingIndex(embedFix);
    const cloudIdx = await ensureCloudEmbeddingIndex(embedFix, { cqrRoot, force: true });
    record(
      'embed.cloud_index_stub',
      Boolean(cloudIdx && cloudIdx.engine === 'stub' && cloudIdx.chunks.length >= 1),
      `engine=${cloudIdx?.engine} n=${cloudIdx?.chunks.length}`,
    );
    const cloudDisk = existsSync(embDir)
      && readdirSync(embDir).some((f) => f.endsWith('.cloud.json'));
    record('embed.cloud_persist', cloudDisk);

    const asyncHits = await searchEmbeddingIndexAsync(embedFix, 'summation integers', {
      cqrRoot,
      maxHits: 5,
    });
    record(
      'embed.cloud_search_stub',
      asyncHits.engine === 'stub' && asyncHits.hits.some((h) => /calc\.ts/i.test(h.path)),
      JSON.stringify({ engine: asyncHits.engine, paths: asyncHits.hits.map((h) => h.path) }),
    );

    // Force cloud API failure → local fallback
    setCloudEmbedBatchForTests(async () => {
      throw new Error('simulated cloud failure');
    });
    invalidateEmbeddingIndex(embedFix);
    const fb = await searchEmbeddingIndexAsync(embedFix, 'summation of integers total', {
      cqrRoot,
      maxHits: 5,
    });
    setCloudEmbedBatchForTests(null);
    record(
      'embed.cloud_fallback_local',
      fb.fallback === true && fb.engine === 'local-hashed-tf' && fb.hits.some((h) => /calc/i.test(h.path)),
      JSON.stringify({ engine: fb.engine, fallback: fb.fallback }),
    );

    const toolCloud = await executeAgentTool(
      embedFix,
      normalizeToolCall({
        id: 'em2',
        type: 'function',
        function: {
          name: 'search_embeddings',
          arguments: JSON.stringify({ query: 'summation integers' }),
        },
      }),
      {},
      { cqrRoot, sessionId: 'eval' },
    );
    record(
      'tool.search_embeddings_cloud',
      /"engine"\s*:\s*"stub"/.test(toolCloud.output) && /calc\.ts/i.test(toolCloud.output),
      toolCloud.output.slice(0, 160),
    );
  } finally {
    setCloudEmbedBatchForTests(null);
    if (prevEmb === undefined) delete process.env.MY_AGENT_EMBEDDINGS;
    else process.env.MY_AGENT_EMBEDDINGS = prevEmb;
    if (prevKey === undefined) delete process.env.MY_AGENT_EMBEDDINGS_API_KEY;
    else process.env.MY_AGENT_EMBEDDINGS_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.MY_AGENT_EMBEDDINGS_BASE_URL;
    else process.env.MY_AGENT_EMBEDDINGS_BASE_URL = prevUrl;
    if (prevModel === undefined) delete process.env.MY_AGENT_EMBEDDINGS_MODEL;
    else process.env.MY_AGENT_EMBEDDINGS_MODEL = prevModel;
  }

  // Metrics
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const guardrailCases = results.filter((r) => r.id.startsWith('guardrail.'));
  const guardrailPass = guardrailCases.filter((r) => r.ok).length;
  const summary = {
    total: results.length,
    passed,
    failed,
    success_rate: results.length ? passed / results.length : 0,
    guardrail_cases: guardrailCases.length,
    guardrail_pass_rate: guardrailCases.length ? guardrailPass / guardrailCases.length : 1,
    results,
  };
  const outPath = path.join(evalRoot, 'metrics.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('\n--- metrics ---');
  console.log(
    JSON.stringify(
      {
        success_rate: summary.success_rate,
        guardrail_pass_rate: summary.guardrail_pass_rate,
        passed,
        failed,
        metrics_file: outPath,
      },
      null,
      2,
    ),
  );

  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
