// Scheduled runs: workspace binding persists and approvals are decided by the decision model.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersonalSchedulerService } from '../core/dist/scheduler/personal-scheduler-service.js';
import { PersonalSchedulerRuntime } from '../core/dist/scheduler/personal-scheduler-runtime.js';
import {
  registerPersonalSchedulerRuntime,
  unregisterPersonalSchedulerRuntime,
} from '../core/dist/scheduler/runtime-registry.js';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';
import { createSchedulerDecisionHooks } from '../core/dist/scheduler/scheduler-decision-hooks.js';
import { STEP_BUDGET_EXTENSION, STEP_BUDGET_MAX_AUTO_GRANTS } from '../core/dist/agent/step-budget-review.js';

const root = mkdtempSync(path.join(tmpdir(), 'cqr-scheduler-binding-'));
const wsA = path.join(root, 'wsA');
const wsB = path.join(root, 'wsB');
let service = PersonalSchedulerService.forRoot(root);
try {
  const base = { name: 'Bound', instruction: 'run it', triggers: [{ type: 'manual', config: {} }] };

  // 1. Normalization: relative/blank dropped, duplicates merged.
  const bound = service.saveTask({ ...base, workspace_roots: [wsA, 'relative/x', '', wsA.toUpperCase(), wsB] });
  assert.deepEqual(bound.workspace_roots?.map((r) => r.toLowerCase()), [wsA, wsB].map((r) => path.resolve(r).toLowerCase()));

  // 2. Update without workspace_roots keeps the binding; [] unbinds.
  const kept = service.saveTask({ ...base, name: 'Renamed' }, bound.id);
  assert.equal(kept.workspace_roots?.length, 2);
  const unbound = service.saveTask({ ...base }, service.saveTask({ ...base, workspace_roots: [wsA] }).id);
  assert.equal(unbound.workspace_roots?.length, 1);
  const cleared = service.saveTask({ ...base, workspace_roots: [] }, unbound.id);
  assert.equal(cleared.workspace_roots, undefined);

  // 3. Persisted across reopen.
  service.close();
  service = PersonalSchedulerService.forRoot(root);
  assert.equal(service.getTask(bound.id)?.workspace_roots?.length, 2);

  // 4. scheduler_upsert binds the creating chat's workspace roots.
  const runtime = new PersonalSchedulerRuntime(service, async () => ({ content: 'ok' }), 60_000);
  runtime.resolveSessionWorkspaceRoots = (id) => (id === 'chat-1' ? [wsB] : []);
  registerPersonalSchedulerRuntime(root, runtime);
  const call = (sessionId) => executeAgentTool(wsA, {
    id: 'c', type: 'function',
    function: { name: 'scheduler_upsert', arguments: JSON.stringify(base) },
  }, {}, { cqrRoot: root, sessionId });
  const fromSession = JSON.parse((await call('chat-1')).output).task;
  assert.deepEqual(fromSession.workspace_roots, [path.resolve(wsB)]);
  const fromRoot = JSON.parse((await call('chat-2')).output).task;
  assert.deepEqual(fromRoot.workspace_roots, [path.resolve(wsA)], 'falls back to the tool workspace root');
  unregisterPersonalSchedulerRuntime(root, runtime);

  // 5. Tool approvals: decision model in delegate mode with the instruction as user request.
  const seen = [];
  const verdicts = ['allow', 'ask_user'];
  const hooks = createSchedulerDecisionHooks({
    providerStore: {},
    cqrRoot: root,
    sessionId: 'automation-x',
    instruction: 'start the dev servers with start.ps1',
    review: async (input) => {
      seen.push({ mode: input.mode, userMessage: input.userMessage });
      return { decision: verdicts.shift(), confidence: 0.9, reason: 'r', reviewer: 'fake/decision' };
    },
    reviewBudget: async ({ facts }) => ({
      verdict: facts.stepsUsed === 999 ? 'stop_ask_user' : 'continue',
      confidence: 0.9, reason: 'b', instruction: '', reviewer: 'fake/budget',
    }),
  });
  const req = { id: '1', tool: 'run_terminal', summary: 'pwsh start.ps1', argsPreview: '{}', danger: false, delegable: true };
  assert.deepEqual(await hooks.onToolApproval(req), { approved: true, by: 'reviewer', reviewer: 'fake/decision' });
  assert.equal((await hooks.onToolApproval(req)).approved, false, 'ask_user is denied — nobody is watching');
  assert.deepEqual(seen.map((s) => s.mode), ['delegate', 'delegate']);
  assert.equal(seen[0].userMessage, 'start the dev servers with start.ps1');

  // 6. Step budget: continue → extend within auto cap; cap reached / stop → stop (never waits).
  const facts = { stepsUsed: 100, stepLimit: 100, elapsedMs: 60_000, trigger: 'steps' };
  const ext = await hooks.onStepBudgetExhausted({ facts, workingModelId: 'm', autoGrantsUsed: 0 });
  assert.equal(ext.extend, STEP_BUDGET_EXTENSION);
  const capped = await hooks.onStepBudgetExhausted({ facts, workingModelId: 'm', autoGrantsUsed: STEP_BUDGET_MAX_AUTO_GRANTS });
  assert.equal(capped.extend, 0);
  assert.ok(capped.stopReason);
  const stopped = await hooks.onStepBudgetExhausted({ facts: { ...facts, stepsUsed: 999 }, workingModelId: 'm', autoGrantsUsed: 0 });
  assert.equal(stopped.extend, 0);
  assert.deepEqual(hooks.decisions.map((d) => d.decision), ['allow', 'deny', 'extend', 'stop', 'stop']);

  console.log(JSON.stringify({ ok: true, checks: ['normalize', 'keep/unbind', 'persist', 'upsert-binding', 'decision-approval', 'step-budget'] }));
} finally {
  service.close();
  rmSync(root, { recursive: true, force: true });
}
