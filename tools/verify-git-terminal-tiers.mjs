#!/usr/bin/env node
/**
 * Terminal git commands are classified by parsed subcommand into fixed tiers:
 * blocked (force push) / severe (hard-to-undo, exact-command approval) / normal.
 * Covers the old substring-regex bypasses (`git -C`, `git -c`, git.exe, `& "...git.exe"`,
 * cmd/powershell wrappers) so they can no longer slip through as `normal`.
 */
import assert from 'node:assert/strict';

const terminal = await import('../core/dist/agent/run-terminal.js');
const approval = await import('../core/dist/agent/tool-approval.js');
const ws = 'D:\\work\\project';
const tier = (c) => terminal.classifyTerminalCommand(c, ws).tier;

const blocked = [
  'git push --force',
  'git push -f origin main',
  'git push -fu origin main',
  'git push --force-with-lease',
  'git push origin +main',
  'git push --mirror',
  'git -C .tmp/worktrees/x push --force',
  'git -c core.x=1 push -f',
  'git.exe push --force',
  '& "C:\\Program Files\\Git\\bin\\git.exe" push --force',
  'cmd /c "git push --force"',
  'powershell -Command "git push -f"',
];
for (const c of blocked) {
  assert.equal(tier(c), 'blocked', c);
  assert.ok(terminal.validateShellCommand(c, ws, c), `approval must not run force push: ${c}`);
  assert.equal(approval.needsHumanApproval('run_terminal', { command: c }, {}, { workspaceRoot: ws }).needed, false, c);
}

const severe = [
  'git push',
  'git push origin main',
  'git push origin --delete feat',
  'git push origin :feat',
  'git -C .tmp/worktrees/x push origin main',
  'git -c core.x=1 push',
  'git --git-dir=.git push',
  'git.exe push',
  '& "C:\\Program Files\\Git\\bin\\git.exe" push',
  'cmd /c "git push"',
  'Set-Location sub; git push',
  'git reset --hard',
  'git reset --hard HEAD~1',
  'git clean -fd',
  'git checkout -- a.ts',
  'git checkout .',
  'git restore a.ts',
  'git restore --staged --worktree a.ts',
  'git switch -f main',
  'git switch --discard-changes main',
  'git stash drop',
  'git stash pop',
  'git stash clear',
  'git branch -D feat',
  'git branch -M main',
  'git tag -d v1',
  'git reflog expire --expire=now --all',
  'git gc --prune=now',
  'git filter-branch --tree-filter x',
  'git worktree remove --force x',
  'git -c alias.p=push p',
];
for (const c of severe) {
  assert.equal(tier(c), 'severe', c);
  assert.match(terminal.validateShellCommand(c, ws), /requires user approval/, c);
  assert.equal(terminal.validateShellCommand(c, ws, c), null, `approved severe runs: ${c}`);
  const req = approval.needsHumanApproval('run_terminal', { command: c }, {}, { workspaceRoot: ws });
  assert.equal(req.needed, true, c);
  assert.equal(req.fixedSeverity, 'severe', c);
}

const normal = [
  'git status',
  'git log --pretty=format:%h',
  'git pull',
  'git fetch',
  'git fetch --prune',
  'git -C .my_agent_remote/o__r fetch --unshallow --tags --prune',
  'git -C .tmp/worktrees/x merge main -m "Merge branch main"',
  'git commit -m "fix git push --force wording"',
  'git add .',
  'git rebase main',
  'git restore --staged a.ts',
  'git clean -n',
  'git branch -d feat',
  'git branch new-x',
  'git checkout main',
  'git checkout -b feat',
  'git switch main',
  'git stash',
  'git stash list',
  'git reset HEAD a.ts',
  'git tag v1',
  'echo pushed',
];
for (const c of normal) {
  assert.equal(tier(c), 'normal', c);
  assert.equal(approval.needsHumanApproval('run_terminal', { command: c }, {}, { workspaceRoot: ws }).fixedSeverity, undefined, c);
}

// Parser: global options skipped, subcommand found.
assert.deepEqual(
  terminal.parseGitInvocations('git -C a -c x=1 --no-pager push origin').map((g) => g.subcommand),
  ['push'],
);
assert.deepEqual(terminal.parseGitInvocations('git status; git.exe fetch').map((g) => g.subcommand), ['status', 'fetch']);

console.log(`verify-git-terminal-tiers: ok (${blocked.length} blocked, ${severe.length} severe, ${normal.length} normal)`);
