#!/usr/bin/env node
/** Product browser smoke against harsh-taskboard fixture. */
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const proj = path.join(root, 'data', '_skill_tool_lab', 'harsh-taskboard');
process.env.MY_AGENT_ROOT = root;

const { executeAgentTool } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/tools.js')).href
);
const { isPlaywrightAvailable } = await import(
  pathToFileURL(path.join(root, 'core/dist/browser/playwright-probe.js')).href
);
const { PlaywrightSession } = await import(
  pathToFileURL(path.join(root, 'core/dist/browser/playwright-session.js')).href
);

const ok = await isPlaywrightAvailable(root);
if (!ok) {
  console.log(JSON.stringify({ ok: false, note: 'playwright unavailable' }, null, 2));
  process.exit(2);
}

const server = createServer((req, res) => {
  let p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const rel = path.normalize(decodeURIComponent(p)).replace(/^(\.\.(\/|\\|$))+/, '');
  const f = path.join(proj, rel);
  if (!existsSync(f) || !f.startsWith(proj)) {
    res.writeHead(404);
    res.end('no');
    return;
  }
  const t = f.endsWith('.js')
    ? 'text/javascript'
    : f.endsWith('.css')
      ? 'text/css'
      : 'text/html';
  res.writeHead(200, { 'Content-Type': `${t}; charset=utf-8` });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

const session = await PlaywrightSession.open({
  cqrRoot: root,
  headless: true,
  urlGuard: { allowLocalhost: true },
});
const ctx = {
  cqrRoot: root,
  sessionId: `product_sm_${Date.now()}`,
  allowLocalhost: true,
  browserSession: session,
};
const tc = (n, a) => ({
  id: `psm_${n}`,
  type: 'function',
  function: { name: n, arguments: JSON.stringify(a) },
});
const steps = [];
async function step(n, a) {
  const r = await executeAgentTool(proj, tc(n, a), { allowNas: false }, ctx);
  const out = String(r.output || '');
  steps.push({ tool: n, label: r.label, out: out.slice(0, 300), hardFail: /^ERROR:/m.test(out) });
}

await step('browser_navigate', { url: base });
await step('browser_evaluate', {
  expression: "document.getElementById('title') && document.getElementById('title').textContent",
});
await step('browser_fill', { selector: '#task-input', value: '깐깐 검수용 할일' });
await step('browser_click', { selector: '#add-btn' });
await step('browser_evaluate', {
  expression:
    "(function(){var n=document.querySelectorAll('#task-list li').length;var t=document.querySelector('#task-list li span');return n+'|'+(t?t.textContent:'');})()",
});
mkdirSync(path.join(proj, '.playwright'), { recursive: true });
await step('browser_screenshot', { path: '.playwright/harsh-product-smoke.png' });

try {
  await session.close?.();
} catch {
  /* ignore */
}
server.close();

const lastEval = steps.findLast?.((s) => s.tool === 'browser_evaluate' && s.out.includes('|'))
  || steps.filter((s) => s.tool === 'browser_evaluate').at(-1);
const listOk =
  lastEval
  && /1\|/.test(lastEval.out)
  && /깐깐/.test(lastEval.out);
const anyFail = steps.some((s) => s.hardFail);
const report = {
  ok: listOk && !anyFail,
  base,
  listOk,
  anyFail,
  steps,
};
writeFileSync(
  path.join(root, 'data', '_skill_tool_lab', 'product-browser-smoke.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
