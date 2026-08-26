// Template: plugin_file_stat
import { existsSync, statSync, readFileSync } from 'node:fs';
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
const rel = typeof args.path === 'string' ? args.path.trim() : '';
if (!rel) {
  console.log(JSON.stringify({ ok: false, error: 'path required' }, null, 2));
  process.exit(0);
}
const target = path.resolve(root, rel);
const rootAbs = path.resolve(root);
if (!target.startsWith(rootAbs) || !existsSync(target)) {
  console.log(JSON.stringify({ ok: false, error: 'not found or escapes workspace', path: rel }, null, 2));
  process.exit(0);
}
const st = statSync(target);
console.log(
  JSON.stringify(
    {
      ok: true,
      plugin: 'plugin_file_stat',
      path: rel,
      is_file: st.isFile(),
      is_dir: st.isDirectory(),
      size: st.size,
      mtime: st.mtime.toISOString(),
    },
    null,
    2,
  ),
);
