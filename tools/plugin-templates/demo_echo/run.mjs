// Template: plugin_demo_echo
import { readFileSync } from 'node:fs';

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
const message = typeof args.message === 'string' ? args.message : 'hello-plugin';
console.log(
  JSON.stringify(
    {
      ok: true,
      plugin: 'plugin_demo_echo',
      message,
      cwd: process.cwd(),
      workspace: process.env.CQR_WORKSPACE_ROOT || null,
    },
    null,
    2,
  ),
);
