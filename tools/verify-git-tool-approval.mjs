#!/usr/bin/env node
// Git builtin tools: 3-tier approval (read / normal / severe) wired to the decision model.
import assert from 'node:assert/strict';

const approval = await import('../core/dist/agent/tool-approval.js');
const review = await import('../core/dist/agent/approval-auto-review.js');
const ws = 'D:\\work\\project';
const need = (tool, args) => approval.needsHumanApproval(tool, args, {}, { workspaceRoot: ws });

// Read tier: no card, never sent to the decision model.
for (const [tool, args] of [
  ['git_status', {}], ['git_diff', {}], ['git_log', {}], ['git_show', {}], ['git_blame', { path: 'a.ts' }],
  ['git_history_tree', {}], ['git_sync_preview', {}], ['git_fetch', {}], ['git_branch', { action: 'list' }],
  ['git_stash', { action: 'list' }], ['git_stash', { action: 'push' }], ['git_stage', { paths: ['a.ts'] }],
  ['git_restore', { paths: ['a.ts'], mode: 'staged' }],
]) {
  assert.equal(approval.classifyGitToolCall(tool, args).tier, 'read', tool);
  assert.equal(need(tool, args).needed, false, `${tool} runs without a card`);
}

// Normal tier: card / decision model, not fixed severe.
for (const [tool, args] of [
  ['git_commit', { message: 'fix', confirm: true }], ['git_pull', { confirm: true }],
  ['git_branch', { action: 'create', name: 'feat', confirm: true }], ['git_switch', { branch: 'main', confirm: true }],
  ['git_init', { confirm: true }],
]) {
  const req = need(tool, args);
  assert.equal(req.needed, true, tool);
  assert.equal(req.fixedSeverity, undefined, tool);
  assert.equal(req.access, 'operation');
  assert.equal(approval.canDelegateToolApproval(tool, args, ws), true, `${tool} delegable`);
}

// Severe tier: fixed severe → explicit command ≥85% only.
for (const [tool, args] of [
  ['git_push', { confirm: true }], ['git_restore', { paths: ['a.ts'], confirm: true }],
  ['git_restore', { paths: ['a.ts'], mode: 'both', confirm: true }], ['git_stash', { action: 'drop', confirm: true }],
  ['git_stash', { action: 'pop', confirm: true }], ['git_switch', { branch: 'main', force_dirty: true, confirm: true }],
]) {
  const req = need(tool, args);
  assert.equal(req.needed, true, tool);
  assert.equal(req.fixedSeverity, 'severe', tool);
  assert.equal(req.danger, true, tool);
  assert.equal(approval.canDelegateToolApproval(tool, args, ws), true, `${tool} delegable (decision model gated)`);
}

// Without confirm=true the tool refuses by itself → no pointless card.
assert.equal(need('git_push', {}).needed, false);
assert.equal(need('git_commit', { message: 'x' }).needed, false);
// NAS repositories are never delegated.
assert.equal(approval.canDelegateToolApproval('git_commit', { confirm: true }, '\\\\nas\\share\\repo'), false);
// Non-git tools are untouched.
assert.equal(approval.classifyGitToolCall('read_file', {}), null);

// Decision mapping for fixed severe (push): explicit yes ≥ 0.85 allows, else asks.
const ans = (label, p) => ({ explicit: { choice: label, probabilities: { [label]: p } } });
assert.equal(review.decideFromAnswers(ans('yes', 0.93), 'delegate', 'severe').decision, 'allow');
assert.equal(review.decideFromAnswers(ans('yes', 0.7), 'delegate', 'severe').decision, 'ask_user');
assert.equal(review.decideFromAnswers(ans('no', 0.95), 'delegate', 'severe').decision, 'ask_user');
assert.equal(review.decideFromAnswers(ans('yes', 0.99), 'triage', 'severe').decision, 'ask_user');

// Decision state carries git facts (branch/remote/mode), not just the summary.
const pushReq = need('git_push', { remote: 'origin', branch: 'main', confirm: true });
const state = review.buildDecisionState('main을 origin에 push해줘', {
  id: 'x', tool: 'git_push', summary: pushReq.summary, argsPreview: JSON.stringify({ remote: 'origin', branch: 'main', confirm: true }),
  danger: true, delegable: true, access: 'operation', fixedSeverity: 'severe',
}, 'delegate');
assert.equal(state.arguments.remote, 'origin');
assert.equal(state.arguments.branch, 'main');
assert.equal(state.facts.fixed_severity, 'severe');
assert.match(String(state.action), /push/i);

console.log('verify-git-tool-approval: OK');
