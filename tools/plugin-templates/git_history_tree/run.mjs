// Template: plugin_git_history_tree — local deploy self-add (read-only)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function readArgs() {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    const doc = JSON.parse(raw);
    return doc.arguments && typeof doc.arguments === 'object' ? doc.arguments : doc;
  } catch {
    return {};
  }
}

const args = readArgs();
const max = Math.min(Math.max(Number(args.max) || 25, 1), 80);
const root = process.env.CQR_WORKSPACE_ROOT || process.cwd();

if (!existsSync(path.join(root, '.git'))) {
  console.log(JSON.stringify({ ok: false, error: 'not a git repository', workspace: root }, null, 2));
  process.exit(0);
}

function git(a) {
  return spawnSync('git', a, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = git(['rev-parse', '--short', 'HEAD']);
const graph = git(['log', '--graph', '--oneline', '--decorate', `--max-count=${max}`]);
const ok = (graph.status ?? 1) === 0;

console.log(
  JSON.stringify(
    {
      ok,
      plugin: 'plugin_git_history_tree',
      workspace: root,
      branch: (branch.stdout || '').trim() || null,
      head: (head.stdout || '').trim() || null,
      max,
      graph_ascii: (graph.stdout || graph.stderr || '').trim() || '(empty)',
      tip: 'If product has builtin git_history_tree, prefer that (richer JSON). This plugin is for local gap installs.',
    },
    null,
    2,
  ),
);
