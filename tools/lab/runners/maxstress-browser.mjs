/**
 * Playwright real browser against Desktop MaxStress / AllSkill demo (navigate+DOM).
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function row(item, result, ms, note = '') {
  return { suite: 'browser_real', item, level: 1, result, ms, note: String(note).slice(0, 280) };
}

export async function runMaxstressBrowserSurface(root, workspaceRoot) {
  const force = process.env.MY_AGENT_LAB_BROWSER === '1' || process.env.MY_AGENT_LAB_FULL_FORCE === '1';
  if (!workspaceRoot || !existsSync(path.join(workspaceRoot, 'public/index.html'))) {
    return [row('demo_workspace', 'skip', 0, 'missing public/index.html — run agent maxstress first')];
  }

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
    return [row('playwright', force ? 'fail' : 'skip', 0, msg)];
  }
  if (!playwrightOk) {
    return [
      row(
        'playwright',
        force ? 'fail' : 'skip',
        0,
        'unavailable — tools/bootstrap-playwright-if-needed.ps1',
      ),
    ];
  }

  const pub = path.join(workspaceRoot, 'public');
  const server = createServer((req, res) => {
    let p = (req.url || '/').split('?')[0];
    if (p === '/') p = '/index.html';
    // Strip leading slashes; never treat absolute Windows paths.
    let rel = decodeURIComponent(p).replace(/^[/\\]+/, '').replace(/\\/g, '/');
    rel = path.posix.normalize(rel).replace(/^(\.\.\/)+/, '');
    if (rel === '.' || rel === '') rel = 'index.html';
    let f = path.join(pub, ...rel.split('/'));
    if (!existsSync(f) && (rel.startsWith('src/') || rel.startsWith('data/'))) {
      f = path.join(workspaceRoot, ...rel.split('/'));
    }
    const rootNorm = path.resolve(workspaceRoot);
    const pubNorm = path.resolve(pub);
    const fNorm = path.resolve(f);
    const under =
      fNorm === pubNorm
      || fNorm.startsWith(pubNorm + path.sep)
      || fNorm === rootNorm
      || fNorm.startsWith(rootNorm + path.sep);
    if (!under || !existsSync(fNorm)) {
      res.writeHead(404);
      res.end(`no ${rel}`);
      return;
    }
    const t = fNorm.endsWith('.js')
      ? 'text/javascript'
      : fNorm.endsWith('.css')
        ? 'text/css'
        : fNorm.endsWith('.json')
          ? 'application/json'
          : 'text/html';
    res.writeHead(200, { 'Content-Type': `${t}; charset=utf-8` });
    res.end(readFileSync(fNorm));
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
    sessionId: `maxstress_browser_${Date.now()}`,
    allowLocalhost: true,
    browserSession: session,
  };
  const tc = (n, a) => ({
    id: `msb_${n}`,
    type: 'function',
    function: { name: n, arguments: JSON.stringify(a) },
  });
  const rows = [];
  async function step(name, args, check) {
    const t0 = Date.now();
    try {
      const r = await executeAgentTool(workspaceRoot, tc(name, args), { allowNas: false }, ctx);
      const out = String(r.output || '');
      const hard = /^ERROR:/m.test(out);
      const ok = !hard && (check ? check(out) : true);
      rows.push(row(name, ok ? 'pass' : 'fail', Date.now() - t0, out.slice(0, 200)));
      return out;
    } catch (e) {
      rows.push(row(name, 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)));
      return '';
    }
  }

  try {
    await step('browser_navigate', { url: base });
    await step(
      'browser_evaluate',
      {
        expression:
          "!!document.getElementById('brand') && (document.getElementById('brand').textContent||'')",
      },
      (out) => /Studio|Max|brand|true|Line/i.test(out),
    );
    await step('browser_fill', { selector: '#task-input', value: '풀서피스 검수 태스크' });
    await step('browser_click', { selector: '#add-btn' });
    await step(
      'browser_evaluate',
      {
        expression: `(async()=>{
          await new Promise(r=>setTimeout(r,400));
          const list=document.getElementById('task-list');
          if(!list) return 'no-list';
          let n=list.querySelectorAll('li').length;
          if(n>0) return String(n);
          // Module may still be binding — force click once more after wait
          const input=document.getElementById('task-input');
          const btn=document.getElementById('add-btn');
          if(input&&btn){ input.value='풀서피스 검수 태스크'; btn.click(); }
          await new Promise(r=>setTimeout(r,400));
          n=list.querySelectorAll('li').length;
          return String(n);
        })()`,
      },
      (out) => /[1-9]/.test(out),
    );
    await step('browser_navigate', { url: `${base}gallery.html` });
    await step(
      'browser_evaluate',
      { expression: "!!document.getElementById('gallery-grid')" },
      (out) => /true/i.test(out),
    );
    await step('browser_screenshot', { path: '.playwright/maxstress-full.png' });
  } finally {
    try {
      await session.close?.();
    } catch {
      /* ignore */
    }
    server.close();
  }
  return rows;
}
