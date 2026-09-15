import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../ui/workspace/node_modules/vite/dist/node/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromiumPath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((candidate) => candidate && existsSync(candidate));
const entry = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { RenderedMarkdownEditor } from '/src/components/RenderedMarkdownEditor.tsx';
  function Fixture() {
    const [content, setContent] = React.useState('# 통합 렌더링\\n\\n선택 문구');
    return React.createElement(RenderedMarkdownEditor, {
      content,
      readOnly: false,
      onChange: value => { window.renderedMarkdown = value; setContent(value); },
      onSelectionChange: value => { window.renderedSelection = value; },
      onAsk: (value, point) => { window.renderedAsk = { value, point }; },
    });
  }
  createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;
let server;
let browser;
try {
  server = await createServer({
    root: path.join(root, 'ui/workspace'),
    configFile: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'rendered-document-ui-test',
      resolveId(id) { if (id === '/test-entry.js') return '\0rendered-document-ui-test'; },
      load(id) { if (id === '\0rendered-document-ui-test') return entry; },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== '/test') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end('<html><body style="background:#222;color:white"><div id="root" style="height:360px"></div><script type="module" src="/test-entry.js"></script></body></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.goto(`${origin}/test`);
  const editor = page.getByRole('textbox', { name: '렌더링 문서 편집' });
  await editor.waitFor();
  assert.equal(await editor.getAttribute('contenteditable'), 'true');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'AI에게 묻기' }).click();
  await page.waitForFunction(() => Boolean(window.renderedAsk));
  assert.match(await page.evaluate(() => window.renderedAsk.value.quote), /문구/);
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' 수정');
  await page.waitForFunction(() => /수정/.test(window.renderedMarkdown || ''));
  console.log('rendered document editor + context interaction: PASS');
} finally {
  await browser?.close();
  await server?.close();
}
