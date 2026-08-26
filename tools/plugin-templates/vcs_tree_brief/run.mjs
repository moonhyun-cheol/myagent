// Template: plugin_vcs_tree_brief — read-only git snapshot (not a builtin shadow)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.env.CQR_WORKSPACE_ROOT || process.cwd();
const gitDir = path.join(root, '.git');

function git(args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  return {
    ok: (r.status ?? 1) === 0,
    out: String(r.stdout || r.stderr || '').trim(),
  };
}

if (!existsSync(gitDir)) {
  console.log(
    JSON.stringify(
      { ok: false, error: 'not a git repository', workspace: root },
      null,
      2,
    ),
  );
  process.exit(0);
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = git(['rev-parse', '--short', 'HEAD']);
const status = git(['status', '--porcelain=v1']);
const stat = git(['diff', '--stat']);

console.log(
  JSON.stringify(
    {
      ok: true,
      plugin: 'plugin_vcs_tree_brief',
      workspace: root,
      branch: branch.out || null,
      head: head.out || null,
      dirty: status.out || '(clean)',
      unstaged_stat: stat.out || '(no unstaged)',
      tip: 'For remote compare use builtin git_sync_preview; this plugin only summarizes local tree.',
    },
    null,
    2,
  ),
);
