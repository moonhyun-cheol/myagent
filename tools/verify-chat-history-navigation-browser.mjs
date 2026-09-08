import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../ui/workspace/package.json', import.meta.url));
const ts = require('typescript');
const { chromium } = require('playwright');
const source = readFileSync(new URL('../ui/workspace/src/lib/chatHistoryNavigation.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const chromiumPath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && existsSync(p));
const browser = await chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
try {
  const page = await browser.newPage();
  await page.setContent(`<div id="history" tabindex="0" style="height:300px;overflow:auto;width:600px"><div id="background" style="padding:24px">${['user','assistant','user','assistant'].map((role,i) => `<article data-id="${i}" data-role="${role}" style="height:400px"><div data-chat-bubble style="width:300px">${role} ${i}<button>action</button></div></article>`).join('')}</div></div><textarea id="input"></textarea>`);
  await page.evaluate(async (js) => {
    const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
    const el = document.querySelector('#history');
    let cursor = null;
    el.addEventListener('click', e => mod.focusHistoryBackground(el, e.target));
    el.addEventListener('keydown', e => {
      const anchors = [...el.querySelectorAll('article')].map(a => ({ id: a.dataset.id, role: a.dataset.role, top: a.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop }));
      cursor = mod.navigateHistory(e, el, anchors, cursor);
    });
  }, js);
  await page.locator('#input').focus();
  await page.locator('#background').click({ position: { x: 500, y: 10 } });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'history');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#history').evaluate(el => el.scrollTop), 812);
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.locator('#history').evaluate(el => el.scrollTop), 412);
  await page.keyboard.press('PageDown');
  assert.equal(await page.locator('#history').evaluate(el => el.scrollTop), 682);
  await page.locator('#input').fill('hello');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#history').evaluate(el => el.scrollTop), 682);
  await page.locator('#history').evaluate(el => { el.scrollTop = 0; });
  await page.locator('button').first().click();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#history').evaluate(el => el.scrollTop), 0);
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BUTTON');
  console.log('PASS: Chromium background focus, turn/message/page navigation, textarea and button isolation');
} finally {
  await browser.close();
}
