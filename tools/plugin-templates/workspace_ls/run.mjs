// Template: plugin_workspace_ls
import { readdirSync, existsSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
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
const root = process.env.CQR_WORKSPACE_ROOT || process.cwd();
const rel = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
const max = Math.min(Math.max(Number(args.max) || 40, 1), 200);
const target = path.resolve(root, rel);
const rootAbs = path.resolve(root);
if (!target.startsWith(rootAbs)) {
  console.log(JSON.stringify({ ok: false, error: 'path escapes workspace' }, null, 2));
  process.exit(0);
}
if (!existsSync(target)) {
  console.log(JSON.stringify({ ok: false, error: 'path not found', path: rel }, null, 2));
  process.exit(0);
}
const ent = readdirSync(target, { withFileTypes: true }).slice(0, max);
const entries = ent.map((e) => {
  const full = path.join(target, e.name);
  let size = null;
  try {
    if (e.isFile()) size = statSync(full).size;
  } catch {
    /* */
  }
  return { name: e.name, kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size };
});
console.log(
  JSON.stringify(
    {
      ok: true,
      plugin: 'plugin_workspace_ls',
      workspace: root,
      path: rel,
      count: entries.length,
      entries,
    },
    null,
    2,
  ),
);
