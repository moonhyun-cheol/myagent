/**
 * Smoke checks for repo-map, workspace-search, fuzzy-edit, chat-filters, agent-hooks.
 * Usage: node tools/verify-agent-context-upgrades.mjs
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cqrRoot = path.resolve(__dirname, '..');
const fixture = path.join(cqrRoot, 'data', '_ctx_upgrade_fixture');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`OK: ${msg}`);
}

async function main() {
  const dist = path.join(cqrRoot, 'core', 'dist');
  const { buildRepoMapContext, focusTokensFromMessage } = await import(
    pathToFileURL(path.join(dist, 'agent/repo-map.js')).href
  );
  const { searchWorkspaceFilesAdvanced } = await import(
    pathToFileURL(path.join(dist, 'agent/workspace-search.js')).href
  );
  const { fuzzyReplaceOnce } = await import(
    pathToFileURL(path.join(dist, 'agent/fuzzy-edit.js')).href
  );
  const { applyChatInletFilter, applyChatOutletFilter } = await import(
    pathToFileURL(path.join(dist, 'chat/chat-filters.js')).href
  );
  const { createDefaultAgentHooks, isHookStop } = await import(
    pathToFileURL(path.join(dist, 'agent/agent-hooks.js')).href
  );
  const { buildDevWorkspaceContext } = await import(
    pathToFileURL(path.join(dist, 'agent/dev-workspace-fs.js')).href
  );

  if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true });
  mkdirSync(path.join(fixture, 'src'), { recursive: true });
  writeFileSync(
    path.join(fixture, 'src', 'math.ts'),
    'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport class Calculator {\n  mul(a: number, b: number) { return a * b; }\n}\n',
  );
  writeFileSync(
    path.join(fixture, 'src', 'app.ts'),
    "import { add } from './math.js';\nconsole.log(add(1, 2));\n",
  );

  const map = buildRepoMapContext(fixture, {
    focusTokens: focusTokensFromMessage('fix Calculator add'),
    maxChars: 4000,
  });
  if (!map.includes('Repository map') || !/add|Calculator/.test(map)) {
    fail(`repo map missing symbols:\n${map}`);
  } else ok('repo-map symbols');

  const ctx = buildDevWorkspaceContext(fixture, {}, {
    tier: 'agent',
    focusMessage: 'Calculator',
    includeRepoMap: true,
  });
  if (!ctx.includes('Repository map')) fail('dev context missing repo map');
  else ok('dev-workspace context includes repo map');

  const hits = searchWorkspaceFilesAdvanced(fixture, 'Calculator', { path: '.' });
  if (!hits.some((h) => h.text.includes('Calculator'))) fail(`search missed Calculator: ${JSON.stringify(hits)}`);
  else ok(`workspace-search hits=${hits.length}`);

  const fuzzy = fuzzyReplaceOnce('hello  \nworld\r\n', 'hello\nworld\n', 'hello\ncosmos\n');
  if (!fuzzy.ok || !fuzzy.content.includes('cosmos')) fail(`fuzzy failed: ${fuzzy.message} => ${JSON.stringify(fuzzy.content)}`);
  else ok(`fuzzy-edit mode=${fuzzy.mode}`);

  const fuzzyIndent = fuzzyReplaceOnce(
    '  function hello() {\n    return 1;\n  }\n',
    'function hello() {\n  return 1;\n}',
    'function hello() {\n  return 2;\n}',
  );
  if (!fuzzyIndent.ok || !fuzzyIndent.content.includes('return 2')) {
    fail(`fuzzy indent failed: ${fuzzyIndent.message}`);
  } else ok(`fuzzy-indent mode=${fuzzyIndent.mode}`);

  const fuzzyBlank = fuzzyReplaceOnce(
    'a\n\n\nb\n',
    'a\n\nb\n',
    'a\n\nc\n',
  );
  if (!fuzzyBlank.ok || !fuzzyBlank.content.includes('c')) {
    fail(`fuzzy blank-line failed: ${fuzzyBlank.message}`);
  } else ok(`fuzzy-blank mode=${fuzzyBlank.mode}`);

  const fuzzyTrim = fuzzyReplaceOnce(
    '  const x = 1;\n  const y = 2;\n',
    'const x = 1;\nconst y = 2;',
    'const x = 9;\nconst y = 2;',
  );
  if (!fuzzyTrim.ok || !/const x = 9/.test(fuzzyTrim.content)) {
    fail(`fuzzy line-trim failed: ${fuzzyTrim.message}`);
  } else ok(`fuzzy-line-trim mode=${fuzzyTrim.mode}`);

  const { needsHumanApproval, largeWriteChars, isSafeVerifyTerminalCommand } = await import(
    pathToFileURL(path.join(dist, 'agent/tool-approval.js')).href
  );
  if (largeWriteChars({}) < 40_000) fail(`largeWrite default too low: ${largeWriteChars({})}`);
  else ok(`HITL large-write default=${largeWriteChars({})}`);
  const mid = needsHumanApproval('write_file', { path: 'a.ts', content: 'x'.repeat(10_000) });
  if (mid.needed) fail('10k write should not HITL at 40k default');
  else ok('HITL mid-size write skipped');
  const big = needsHumanApproval('write_file', { path: 'a.ts', content: 'x'.repeat(45_000) });
  if (!big.needed) fail('45k write should HITL');
  else ok('HITL oversized write still gated');
  const patchMid = needsHumanApproval('apply_patch', { files: [{ path: 'a.ts', edits: [{ old_text: 'a'.repeat(9_000), new_text: 'b' }] }] });
  if (patchMid.needed) fail('~9k patch should not HITL at 80k default');
  else ok('HITL mid-size patch skipped');
  if (!isSafeVerifyTerminalCommand('node --check app.js')) fail('node --check should be safe');
  const safeTerm = needsHumanApproval('run_terminal', { command: 'node --check app.js' }, {});
  if (safeTerm.needed) fail('safe verify terminal should skip HITL by default');
  else ok('HITL safe terminal skipped');
  const unsafeTerm = needsHumanApproval('run_terminal', { command: 'rm -rf /' }, {});
  if (!unsafeTerm.needed) fail('destructive terminal must HITL');
  else ok('HITL unsafe terminal still gated');
  const safeOff = needsHumanApproval(
    'run_terminal',
    { command: 'node --check app.js' },
    { MY_AGENT_HITL_SAFE_TERMINAL: '0' },
  );
  if (!safeOff.needed) fail('MY_AGENT_HITL_SAFE_TERMINAL=0 must still HITL');
  else ok('HITL safe terminal respects opt-out');

  const { buildTaskChecklist, looksLikeGreenfieldScaffold } = await import(
    pathToFileURL(path.join(dist, 'agent/agent-task-checklist.js')).href
  );
  if (!looksLikeGreenfieldScaffold('빈 폴더에 발주 추적 웹앱을 처음부터 만들어라')) {
    fail('greenfield scaffold detect');
  } else ok('greenfield scaffold detect');
  const gf = buildTaskChecklist('빈 폴더에 index.html app.js 를 처음부터 만들어라');
  if (gf.requireRetrieval) fail('greenfield must skip retrieval-first');
  else ok('greenfield skips retrieval-first');
  const ref = buildTaskChecklist('여러 파일 리팩토링해 tools.ts 와 agent-run-loop.ts');
  if (!ref.requireRetrieval) fail('multi-file refactor must require retrieval');
  else ok('refactor keeps retrieval-first');
  const { retrievalToolsUsed } = await import(
    pathToFileURL(path.join(dist, 'agent/agent-task-checklist.js')).href
  );
  const multi = buildTaskChecklist('여러 파일로 index.html 과 app.js 수정해');
  if (!multi.requireRetrieval) fail('multi-file ask should require retrieval');
  if (!retrievalToolsUsed(['list_directory'], multi)) fail('list_directory should soft-satisfy multi-file');
  else ok('list_directory soft-satisfies multi-file retrieval');
  if (!retrievalToolsUsed(['read_file'], multi)) fail('read_file should soft-satisfy multi-file');
  else ok('read_file soft-satisfies multi-file retrieval');
  const split = buildTaskChecklist('tools.ts 도구 정의 분리해 registry로 추출');
  if (retrievalToolsUsed(['list_directory'], split)) fail('list_directory must NOT soft-satisfy split');
  else ok('list_directory does not soft-satisfy structural split');
  if (retrievalToolsUsed(['read_file'], split)) fail('read_file must NOT soft-satisfy split');
  else ok('read_file does not soft-satisfy structural split');
  const rs = buildTaskChecklist('동일 프로그램 재구성 adapters/ delivery/ 구조 정리');
  if (!rs.labels.includes('restructure')) fail('restructure label');
  else ok('restructure label');
  const fieldNorm = buildTaskChecklist(
    '여러 파일 리팩토링 adapters/looka.js mstock 필드 normalize 포함 delivery/discord-webhook.js',
  );
  if (fieldNorm.labels.includes('structural split')) {
    fail('data-field normalize must not label structural split');
  } else ok('data-field normalize is not structural split');
  if (!retrievalToolsUsed(['read_file'], fieldNorm)) {
    fail('read_file should soft-satisfy field-normalize refactor');
  } else ok('read_file soft-satisfies field-normalize refactor');
  const openClawMsg =
    'OpenClaw 금지. Bot Token/discord.js 금지. src/looka/client.js 확인';
  const { inferToolFromUserMessage } = await import(
    pathToFileURL(path.join(dist, 'agent/agent-run-helpers.js')).href
  );
  const inferred = inferToolFromUserMessage(openClawMsg, ['read_file', 'list_directory']);
  const inferredPath = inferred
    ? JSON.parse(inferred.function.arguments || '{}').path
    : null;
  if (inferredPath === 'discord.js' || /Token\/discord/i.test(String(inferredPath || ''))) {
    fail('inferTool must not pick discord.js from OpenClaw ban');
  } else if (inferredPath && /looka\/client\.js/.test(String(inferredPath))) {
    ok('inferTool prefers workspace path over discord.js');
  } else {
    fail('inferTool should pick src/looka/client.js (got ' + String(inferredPath) + ')');
  }

  const { appendPostMutateWiringSmoke, outputHasWiringSmoke } = await import(
    pathToFileURL(path.join(dist, 'agent/agent-runtime-smoke.js')).href
  );
  {
    const wireDir = path.join(fixture, 'wire');
    mkdirSync(wireDir, { recursive: true });
    writeFileSync(path.join(wireDir, 'index.html'), '<div id="a"></div>', 'utf8');
    writeFileSync(
      path.join(wireDir, 'app.js'),
      "document.getElementById('b');\nfunction init(){}\ninit();\n",
      'utf8',
    );
    const out = appendPostMutateWiringSmoke(wireDir, ['app.js'], 'Wrote app.js');
    if (!outputHasWiringSmoke(out) || !/dom_id:#b/.test(out)) fail(`wiring smoke gate missing: ${out}`);
    else ok('post-mutate wiring smoke gate');
  }

  const inlet = applyChatInletFilter('token=sk-abcdefghijklmnopqrstuvwxyz0123456789');
  if (!inlet.text.includes('REDACTED') || inlet.blocked) fail(`inlet bad: ${JSON.stringify(inlet)}`);
  else ok('chat inlet redacts secrets');

  const outlet = applyChatOutletFilter('token=sk-abcdefghijklmnopqrstuvwxyz0123456789');
  if (!outlet.text.includes('REDACTED')) fail(`outlet bad: ${outlet.text}`);
  else ok('chat outlet redacts secrets');

  const hooks = createDefaultAgentHooks();
  const blocked = await hooks.beforeTool?.({
    tool: 'write_file',
    args: { content: '-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----' },
    step: 1,
  });
  if (!isHookStop(blocked)) fail('hook should block private key args');
  else ok('agent-hooks blocks private key');

  rmSync(fixture, { recursive: true, force: true });
  if (!process.exitCode) console.log('verify-agent-context-upgrades: all passed');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
