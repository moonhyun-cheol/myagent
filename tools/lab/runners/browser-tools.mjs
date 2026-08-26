/**
 * Browser tools L1 — local fixture HTTP server + PlaywrightSession.
 * Skips cleanly when Playwright unavailable unless MY_AGENT_LAB_BROWSER=1 forces fail on missing.
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function row(item, result, ms, note = '') {
  return { suite: 'browser', item, level: 1, result, ms, note: String(note).slice(0, 240) };
}

async function withLocalServer(html, fn) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

export async function runBrowserTools(root, fixture, opts = {}) {
  const force = opts.force || process.env.MY_AGENT_LAB_BROWSER === '1';
  const rows = [];
  let playwrightOk = false;
  let PlaywrightSession;
  let executeAgentTool;

  try {
    const probe = await import(
      pathToFileURL(path.join(root, 'core/dist/browser/playwright-probe.js')).href
    );
    playwrightOk = await probe.isPlaywrightAvailable(root);
    ({ PlaywrightSession } = await import(
      pathToFileURL(path.join(root, 'core/dist/browser/playwright-session.js')).href
    ));
    ({ executeAgentTool } = await import(
      pathToFileURL(path.join(root, 'core/dist/agent/tools.js')).href
    ));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (force) {
      return [
        row('browser_pack', 'fail', 0, `import failed: ${msg}`),
      ];
    }
    return ['browser_navigate', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_evaluate'].map(
      (n) => row(n, 'skip', 0, `playwright unavailable: ${msg}`),
    );
  }

  if (!playwrightOk) {
    if (force) {
      return [row('browser_pack', 'fail', 0, 'Playwright not available (run tools/bootstrap-playwright.ps1)')];
    }
    return ['browser_navigate', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_evaluate'].map(
      (n) => row(n, 'skip', 0, 'playwright unavailable'),
    );
  }

  const html = `<!doctype html><html><body>
    <h1 id="lab">lab</h1>
    <input id="inp" type="text" value="" />
    <button id="btn" type="button">go</button>
    <p id="out"></p>
    <script>
      document.getElementById('btn').onclick = function () {
        document.getElementById('out').textContent = document.getElementById('inp').value || 'clicked';
      };
    </script>
  </body></html>`;

  const sessionId = `lab_browser_${Date.now()}`;
  let session;
  try {
    session = await PlaywrightSession.open({
      cqrRoot: root,
      headless: true,
      urlGuard: { allowLocalhost: true },
    });
  } catch (e) {
    return [
      row(
        'browser_pack',
        force ? 'fail' : 'skip',
        0,
        e instanceof Error ? e.message : String(e),
      ),
    ];
  }

  const ctx = {
    cqrRoot: root,
    sessionId,
    allowLocalhost: true,
    browserSession: session,
  };
  const tc = (name, args) => ({
    id: `lab_${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args || {}) },
  });

  try {
    await withLocalServer(html, async (base) => {
      const steps = [
        ['browser_navigate', { url: base }],
        ['browser_evaluate', { expression: 'document.getElementById("lab")?.textContent' }],
        ['browser_fill', { selector: '#inp', value: 'cqr-lab' }],
        ['browser_click', { selector: '#btn' }],
        ['browser_screenshot', { path: 'lab-browser.png' }],
      ];
      for (const [name, args] of steps) {
        const t0 = Date.now();
        try {
          const res = await executeAgentTool(fixture, tc(name, args), { allowNas: false }, ctx);
          const out = String(res.output || '');
          const ok = !/^ERROR:/m.test(out);
          rows.push(row(name, ok ? 'pass' : 'fail', Date.now() - t0, ok ? (res.label || 'ok') : out.slice(0, 200)));
        } catch (e) {
          rows.push(row(name, 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)));
        }
      }
    });
  } finally {
    try {
      await session.close();
    } catch {
      /* ignore */
    }
  }

  for (const name of [
    'browser_navigate',
    'browser_screenshot',
    'browser_click',
    'browser_fill',
    'browser_evaluate',
  ]) {
    if (!rows.some((r) => r.item === name)) {
      rows.push(row(name, 'fail', 0, 'not exercised'));
    }
  }

  return rows;
}
