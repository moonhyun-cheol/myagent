// Template: plugin_json_read
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
const root = process.env.CQR_WORKSPACE_ROOT || process.cwd();
const rel = typeof args.path === 'string' ? args.path.trim() : '';
if (!rel || !rel.toLowerCase().endsWith('.json')) {
  console.log(JSON.stringify({ ok: false, error: 'path must be a .json file' }, null, 2));
  process.exit(0);
}
const target = path.resolve(root, rel);
const rootAbs = path.resolve(root);
if (!target.startsWith(rootAbs) || !existsSync(target)) {
  console.log(JSON.stringify({ ok: false, error: 'not found or escapes', path: rel }, null, 2));
  process.exit(0);
}
let data;
try {
  data = JSON.parse(readFileSync(target, 'utf8'));
} catch (e) {
  console.log(
    JSON.stringify(
      { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` },
      null,
      2,
    ),
  );
  process.exit(0);
}
const keys =
  data && typeof data === 'object' && !Array.isArray(data)
    ? Object.keys(data).slice(0, 50)
    : [];
console.log(
  JSON.stringify(
    {
      ok: true,
      plugin: 'plugin_json_read',
      path: rel,
      type: Array.isArray(data) ? 'array' : typeof data,
      top_keys: keys,
      array_len: Array.isArray(data) ? data.length : null,
    },
    null,
    2,
  ),
);
