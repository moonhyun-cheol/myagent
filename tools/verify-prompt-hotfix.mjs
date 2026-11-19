#!/usr/bin/env node
// Prompt hotfix contract: "remaining work" must not read as a blocker, a blocked task is
// re-evaluated on a new request, non-file work can be completed, earlier evidence is listed,
// and plain Korean sentence words are not auto-searched.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildAgentMessages } = await import('../core/dist/agent/agent-run-helpers.js');
const { formatActiveTaskSystemNote, setSessionActiveTask, loadAgentRunMeta } = await import(
  '../core/dist/agent/agent-run-meta.js'
);
const { formatPriorEvidenceTurnNote } = await import('../core/dist/agent/agent-evidence-store.js');
const { indexQueryCandidatesFromMessage } = await import('../core/dist/agent/agent-workspace-index.js');
const { applyHistoryContextCompress } = await import('../core/dist/chat/history-budget.js');
const { executeAgentTool } = await import('../core/dist/agent/agent-tool-execute.js');
const { TOKEN_EFFICIENCY_PRINCIPLES } = await import('../core/dist/agent/agent-token-efficiency.js');
const guard = await import('../core/dist/agent/tool-loop-guard.js');

const ws = mkdtempSync(path.join(os.tmpdir(), 'my-agent-prompt-hotfix-'));
try {
  // 1) System prompt wording.
  writeFileSync(path.join(ws, 'alpha.ts'), 'export const alpha = 1;\n', 'utf8');
  const system = buildAgentMessages(
    { workspaceRoot: ws, cqrRoot: ws, userMessage: '시작해줘', providerId: 'custom', providerStore: {}, sessionId: 'hotfix' },
    {}, ['read_file', 'run_terminal', 'active_task'], false, null, '', false, false,
  ).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert.match(system, /Remaining work is not a blocker/);
  assert.match(system, /Use active_task block only when the next required step cannot be attempted now/);
  assert.match(system, /resume it with active_task set/);
  assert.match(system, /are not proof of absence/);
  assert.match(system, /evidence stored earlier in this session/);
  assert.doesNotMatch(system, /set\/block before answering|Manager Restart|NEVER invent|without read_file this run/);
  assert.match(TOKEN_EFFICIENCY_PRINCIPLES.join('\n'), /not remaining work/);

  // 2) Tool description + turn note.
  const defs = readFileSync(new URL('../core/src/agent/agent-tool-definitions.ts', import.meta.url), 'utf8');
  assert.match(defs, /Unfinished, unimplemented, or unverified work is not a blocker/);
  assert.doesNotMatch(defs, /may be blocked\/deferred|'Current blocker; required for block'/);
  const task = { updatedAt: 'x', status: 'blocked', objective: 'o', acceptance: 'a', blocker: '구현 미완료' };
  assert.match(formatActiveTaskSystemNote(task), /Do not assume the stored blocker is still true/);
  assert.match(formatActiveTaskSystemNote(task), /keep it active \(set\)/);
  assert.doesNotMatch(formatActiveTaskSystemNote({ ...task, status: 'active', blocker: undefined }), /stored blocker/);

  // 3) Completion: file changes still need a check; non-file work needs reason + real work.
  const call = (args) => ({ id: 'c', type: 'function', function: { name: 'active_task', arguments: JSON.stringify(args) } });
  const run = async (args, evidence) => (await executeAgentTool(ws, call(args), {}, {
    cqrRoot: ws, sessionId: 'hotfix', getRunEvidence: () => evidence,
  })).output;
  const reset = () => setSessionActiveTask(ws, 'hotfix', { updatedAt: 'x', status: 'active', objective: 'o', acceptance: 'a' });
  const status = () => loadAgentRunMeta(ws, 'hotfix').activeTask?.status;

  reset();
  assert.match(await run({ action: 'complete' }, { mutatedPaths: ['a.ts'], acceptanceOk: false, workToolUsed: true }),
    /REQUIRES_VERIFICATION/);
  assert.equal(status(), 'active', 'unverified file change stays active');
  assert.match(await run({ action: 'complete' }, { mutatedPaths: ['a.ts'], acceptanceOk: true }), /"ok":true/);
  assert.equal(status(), 'done');

  reset();
  assert.match(await run({ action: 'complete' }, { mutatedPaths: [], acceptanceOk: false, workToolUsed: true }),
    /REQUIRES_EVIDENCE/, 'no files changed and no reason');
  assert.match(await run({ action: 'complete', reason: '분석 완료' }, { mutatedPaths: [], acceptanceOk: false, workToolUsed: false }),
    /REQUIRES_EVIDENCE/, 'reason alone, with no work in this run');
  assert.equal(status(), 'active');
  assert.match(await run({ action: 'complete', reason: 'run_terminal로 산출물 생성·확인' },
    { mutatedPaths: [], acceptanceOk: false, workToolUsed: true }), /"ok":true/);
  assert.equal(status(), 'done', 'non-file work can be completed');

  reset();
  assert.match(await run({ action: 'block' }, { mutatedPaths: [], acceptanceOk: false }), /requires blocker/);
  assert.match(await run({ action: 'block', blocker: '사용자가 승인을 거절함' }, { mutatedPaths: [], acceptanceOk: false }), /"status":"blocked"/);
  assert.match(await run({ action: 'set', objective: 'o', acceptance: 'a' }, { mutatedPaths: [], acceptanceOk: false }),
    /"status":"active"/, 'set resumes a blocked task');
  assert.equal(loadAgentRunMeta(ws, 'hotfix').activeTask?.blocker, undefined, 'resumed task carries no stale blocker');

  // 4) Stored evidence index.
  const rec = (n, extra = {}) => ({
    version: 1, evidenceId: `ev_r_${n}`, runId: 'r', tool: 'read_file', args: { path: `src/f${n}.ts` },
    source: { path: `src/f${n}.ts`, kind: 'workspace_file' }, coverage: { returnedRanges: [{ start: 1, end: 40 }] },
    complete: true, fingerprint: 'x', ok: true, at: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
    bytes: 1, bodyFile: 'b', observedByModel: true, ...extra,
  });
  assert.equal(formatPriorEvidenceTurnNote([]), '');
  assert.equal(formatPriorEvidenceTurnNote(undefined), '');
  const note = formatPriorEvidenceTurnNote([
    rec(1), rec(2, { ok: false }), rec(3, { tool: 'active_task', args: {}, source: undefined, coverage: undefined }),
    rec(4, { tool: 'run_terminal', args: { command: 'npm test' }, source: { kind: 'terminal' }, coverage: undefined }),
  ]);
  assert.match(note, /ev_r_1 · read_file · src\/f1\.ts L1-40/);
  assert.match(note, /ev_r_4 · run_terminal · npm test/);
  assert.doesNotMatch(note, /ev_r_2|ev_r_3/, 'failed and bookkeeping records are not listed');
  assert.match(note, /evidence_read/);
  const many = formatPriorEvidenceTurnNote(Array.from({ length: 30 }, (_, i) => rec(i + 1)));
  assert.equal(many.split('\n').filter((l) => l.startsWith('- ')).length, 12, 'index is capped');
  assert.match(many, /ev_r_30/);
  assert.match(many, /18 older entries not listed/);

  // 5) Auto pre-search: plain Korean sentence words are not queries; quoted text and identifiers are.
  assert.deepEqual(indexQueryCandidatesFromMessage('이런거 왜에도 제품으 답변 퀄리티에 영향을 주는 이슈들을 점검해줘'), []);
  assert.ok(indexQueryCandidatesFromMessage('"저장되었습니다" 문구를 바꿔줘').includes('저장되었습니다'));
  assert.ok(indexQueryCandidatesFromMessage('MainWindow.xaml 고쳐줘').some((q) => /MainWindow/.test(q)));
  assert.ok(indexQueryCandidatesFromMessage('MY_AGENT 로그 확인').includes('MY_AGENT'));

  // 6) Fold note keeps a longer assistant excerpt (was 120 chars).
  const hist = [];
  for (let i = 0; i < 10; i++) {
    hist.push({ role: 'user', content: `u${i} ${'질문 '.repeat(100)}` });
    hist.push({ role: 'assistant', content: `a${i} ${'가'.repeat(300)}결론표식${i} ${'나'.repeat(300)}` });
  }
  const folded = applyHistoryContextCompress(hist, { MY_AGENT_HISTORY_KEEP_RECENT: '4', MY_AGENT_HISTORY_COMPRESS_CHARS: '600' });
  assert.match(folded[0].content, /\[history compress · /);
  assert.match(folded[0].content, /결론표식0/, 'assistant conclusion within 400 chars survives the fold');

  // 7) Loop-guard wording: no mutation steering, no internal names in user-facing text.
  const src = readFileSync(new URL('../core/src/agent/tool-loop-guard.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /code-agent를 멈췄|「수정 완료」라고 쓰지 마세요|call edit_file \/ apply_patch \/ write_file now/);
  const userStop = guard.formatConsecutiveFailureStop(6, 6);
  assert.match(userStop, /^중단: /);
  assert.doesNotMatch(userStop, /code-agent|edit_file|apply_patch/);

  console.log('verify-prompt-hotfix: ok');
} finally {
  rmSync(ws, { recursive: true, force: true });
}
