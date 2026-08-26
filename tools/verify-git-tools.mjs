/**
 * Enterprise git tools smoke (Cursor-parity subset).
 * Loop-friendly: fail loudly → fix tools → re-run.
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) fail(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const distMain = join(root, 'core', 'dist', 'agent', 'run-terminal.js');
if (!existsSync(distMain)) {
  const build = spawnSync(process.execPath, [join(root, 'tools', 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (build.status !== 0) fail('build failed');
}

const rt = await import(pathToFileURL(distMain).href);
const {
  gitStatus,
  gitDiff,
  gitLog,
  gitFetch,
  gitPull,
  gitPush,
  gitSyncPreview,
  gitShow,
  gitBlame,
  gitBranch,
  gitSwitch,
  gitStage,
  gitRestore,
  gitStash,
  gitCommit,
  runTerminalCommand,
  isAllowedCqrRemoteInspectGitShell,
} = rt;

// Catalog check: definitions include new tools
const defPath = join(root, 'core', 'dist', 'agent', 'agent-tool-definitions.js');
if (existsSync(defPath)) {
  const defs = await import(pathToFileURL(defPath).href);
  const names = (defs.CODE_AGENT_TOOL_NAMES || []).slice();
  for (const need of [
    'git_sync_preview',
    'git_show',
    'git_blame',
    'git_branch',
    'git_switch',
    'git_stage',
    'git_restore',
    'git_stash',
    'git_push',
  ]) {
    if (!names.includes(need)) fail(`tool missing from catalog: ${need}`);
  }
  console.log('OK catalog has enterprise git tools');
}

const dir = mkdtempSync(join(tmpdir(), 'cqr-git-tools-'));
try {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@cqr.local']);
  git(dir, ['config', 'user.name', 'CQR Test']);
  writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', 'c1']);
  git(dir, ['branch', '-M', 'main']);

  // --- status / show / blame ---
  const st = gitStatus(dir);
  if (!st.includes('main')) fail(`status: ${st}`);
  console.log('OK git_status');

  const show = gitShow(dir, { ref: 'HEAD', stat_only: true });
  if (!/c1|a\.txt|files? changed/i.test(show) && !show.includes('a.txt')) {
    // stat may say "1 file changed"
    if (!show.trim()) fail(`show empty: ${show}`);
  }
  console.log('OK git_show');

  const blame = gitBlame(dir, 'a.txt');
  if (!blame.includes('one') && !/^\^?\w+/.test(blame)) fail(`blame: ${blame.slice(0, 200)}`);
  console.log('OK git_blame');

  // --- dirty diff + stage + commit ---
  writeFileSync(join(dir, 'a.txt'), 'two\n', 'utf8');
  const dirty = gitDiff(dir);
  if (!dirty.includes('two')) fail(`dirty diff: ${dirty}`);
  console.log('OK git_diff working tree');

  const stage = JSON.parse(gitStage(dir, { paths: ['a.txt'] }));
  if (!stage.ok) fail(`stage: ${JSON.stringify(stage)}`);
  console.log('OK git_stage');

  const commitNo = JSON.parse(gitCommit(dir, 'c2', { confirm: false }));
  if (commitNo.ok !== false) fail('commit without confirm');
  const commit = JSON.parse(gitCommit(dir, 'c2', { confirm: true }));
  if (!commit.ok) fail(`commit: ${JSON.stringify(commit)}`);
  console.log('OK git_commit');

  // --- branch create + switch ---
  const brList = JSON.parse(gitBranch(dir, { action: 'list' }));
  if (!brList.ok || !String(brList.branches).includes('main')) fail(`branch list: ${JSON.stringify(brList)}`);
  const brCreate = JSON.parse(gitBranch(dir, { action: 'create', name: 'feat-x', confirm: true }));
  if (!brCreate.ok) fail(`branch create: ${JSON.stringify(brCreate)}`);
  const sw = JSON.parse(gitSwitch(dir, { branch: 'feat-x', confirm: true }));
  if (!sw.ok) fail(`switch: ${JSON.stringify(sw)}`);
  console.log('OK git_branch + git_switch');

  // --- stash ---
  writeFileSync(join(dir, 'a.txt'), 'three\n', 'utf8');
  const stashPush = JSON.parse(gitStash(dir, { action: 'push', message: 'wip' }));
  if (!stashPush.ok) fail(`stash push: ${JSON.stringify(stashPush)}`);
  const stashList = JSON.parse(gitStash(dir, { action: 'list' }));
  if (!String(stashList.stashes).includes('wip') && stashList.stashes === '(empty)') {
    fail(`stash list empty: ${JSON.stringify(stashList)}`);
  }
  const stashPopNo = JSON.parse(gitStash(dir, { action: 'pop', confirm: false }));
  if (stashPopNo.ok !== false) fail('stash pop without confirm');
  const stashPop = JSON.parse(gitStash(dir, { action: 'pop', confirm: true, index: 0 }));
  if (!stashPop.ok) fail(`stash pop: ${JSON.stringify(stashPop)}`);
  console.log('OK git_stash');

  // --- restore worktree (discard) ---
  writeFileSync(join(dir, 'a.txt'), 'discard-me\n', 'utf8');
  const restNo = JSON.parse(
    gitRestore(dir, { paths: ['a.txt'], mode: 'worktree', confirm: false }),
  );
  if (restNo.ok !== false) fail('restore without confirm');
  const rest = JSON.parse(
    gitRestore(dir, { paths: ['a.txt'], mode: 'worktree', confirm: true }),
  );
  if (!rest.ok) fail(`restore: ${JSON.stringify(rest)}`);
  if (readFileSync(join(dir, 'a.txt'), 'utf8').includes('discard-me')) fail('restore did not discard');
  console.log('OK git_restore');

  // --- sync preview (no remote) ---
  const preview = JSON.parse(gitSyncPreview(dir, { fetch: false }));
  if (!preview.ok || !preview.branch) fail(`sync_preview: ${JSON.stringify(preview)}`);
  console.log('OK git_sync_preview');

  // --- pull/push require confirm ---
  if (JSON.parse(gitPull(dir, { confirm: false })).ok !== false) fail('pull confirm');
  if (JSON.parse(gitPush(dir, { confirm: false })).ok !== false) fail('push confirm');
  console.log('OK git_pull/git_push confirm gates');

  // --- terminal blocklist (enterprise: no raw git write via shell) ---
  for (const cmd of [
    'git pull',
    'git fetch',
    'git push',
    'git commit -m x',
    'git switch main',
    'git stash',
    'git add .',
    'git branch',
  ]) {
    const blocked = runTerminalCommand(dir, cmd);
    if (blocked.ok || !String(blocked.stderr).includes('blocked')) {
      fail(`run_terminal should block: ${cmd} → ${JSON.stringify(blocked)}`);
    }
  }
  console.log('OK run_terminal blocks git writes');

  // --- .my_agent_remote inspect: format= / fetch --unshallow allowed via git -C ---
  const remoteDir = join(dir, '.my_agent_remote', 'owner__demo');
  mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, ['init']);
  writeFileSync(join(remoteDir, 'README.md'), 'demo\n', 'utf8');
  git(remoteDir, ['add', 'README.md']);
  git(remoteDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
  const prettyLog = runTerminalCommand(
    dir,
    'git -C .my_agent_remote/owner__demo log --pretty=format:%h%x09%s -n 5',
  );
  if (!prettyLog.ok) {
    fail(`cqr_remote pretty=format should be allowed: ${JSON.stringify(prettyLog)}`);
  }
  if (!isAllowedCqrRemoteInspectGitShell('git -C .my_agent_remote/owner__demo fetch --unshallow --tags --prune')) {
    fail('isAllowedCqrRemoteInspectGitShell unshallow');
  }
  const bareFetchStillBlocked = runTerminalCommand(dir, 'git fetch');
  if (bareFetchStillBlocked.ok || !String(bareFetchStillBlocked.stderr).includes('blocked')) {
    fail('bare git fetch must stay blocked');
  }
  console.log('OK cqr_remote inspect git shell allowlist');

  // fetch without remote soft-fails
  const fetchOut = JSON.parse(gitFetch(dir, {}));
  console.log(fetchOut.ok ? 'OK git_fetch' : 'OK git_fetch reports missing remote');

  console.log('verify-git-tools: OK');
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
