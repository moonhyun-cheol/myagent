/**
 * verify-web-action-audit — browser / web download / user MCP calls leave one `web_action`
 * ledger event (surface, action, host, outcome) and never log values, expressions, query
 * strings or page content. Uses a temp CQR root and a stub isolated session (no network).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';
import {
  recordWebActionAudit,
  webAuditOutcome,
  webAuditHostFrom,
  isAuditedWebTool,
} from '../core/dist/agent/web-action-audit.js';
import { summarizeAgentAuditLedger, formatAuditSummaryBrief } from '../core/dist/agent/agent-audit-ledger.js';

const SECRET_VALUE = 'S3CRET-fill-value-9471';
const SECRET_EXPR = 'document.cookie+"EXPR-MARK-5521"';
const SECRET_QUERY = 'token=QUERY-MARK-7713';
const PAGE_BODY = 'PAGE-BODY-MARK-3390';

// ── 1. Pure helpers ─────────────────────────────────────────────────────────
assert.equal(isAuditedWebTool('browser_click'), true);
assert.equal(isAuditedWebTool('save_web_asset'), true);
assert.equal(isAuditedWebTool('mcp_mail_send'), true);
assert.equal(isAuditedWebTool('read_file'), false);
assert.equal(webAuditHostFrom({ url: `https://Shop.Demo-Store.kr:8443/a/b?${SECRET_QUERY}` }), 'shop.demo-store.kr:8443');
assert.equal(webAuditHostFrom({}, '{"page_url":"https://news.demo-news.kr/x?y=1"}'), 'news.demo-news.kr');
assert.equal(webAuditHostFrom({}, 'ERROR: BLOCKED_PAGE — the visible browser is on a blocked URL (https://admin.corp-test.kr/p).'), 'admin.corp-test.kr');
assert.equal(webAuditHostFrom({ url: 'javascript:alert(1)' }), undefined);
assert.equal(webAuditOutcome('ERROR: BLOCKED_PAGE — x'), 'blocked');
assert.equal(webAuditOutcome('ERROR: BLOCKED_BY_USER_POLICY: x'), 'blocked');
assert.equal(webAuditOutcome('{"ok":false,"error":"VISIBLE_BROWSER_CONTROL_TAKEN_OVER"}'), 'taken_over');
assert.equal(webAuditOutcome('ERROR: something'), 'error');
assert.equal(webAuditOutcome('{"ok":true,"url":"https://a.demo.kr"}'), 'ok');

// ── 2. Real executeAgentTool path with a stub isolated session ─────────────
const cqrRoot = mkdtempSync(path.join(os.tmpdir(), 'web-audit-'));
try {
  const stub = {
    navigate: async (url) => ({ ok: true, url, title: 't', text: PAGE_BODY }),
    fill: async () => JSON.stringify({ ok: true, url: 'https://form.demo-login.kr/login' }),
    snapshot: async () => ({ ok: true, url: 'https://form.demo-login.kr/login', text: PAGE_BODY }),
    evaluate: async () => JSON.stringify({ ok: true, value: PAGE_BODY }),
    click: async () => JSON.stringify({ ok: true }),
  };
  const ctx = {
    cqrRoot,
    sessionId: 'audit-session',
    browserRouting: 'interactive',
    getIsolatedBrowserSession: async () => stub,
  };
  const call = (name, args) => ({ id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const ws = process.cwd();

  await executeAgentTool(ws, call('browser_navigate', { url: `https://shop.demo-store.kr/p?${SECRET_QUERY}` }), {}, ctx);
  await executeAgentTool(ws, call('browser_fill', { selector: '#pw', value: SECRET_VALUE }), {}, ctx);
  await executeAgentTool(ws, call('browser_snapshot', {}), {}, ctx);
  await executeAgentTool(ws, call('browser_evaluate', { target: 'isolated', expression: SECRET_EXPR }), {}, ctx);
  await executeAgentTool(ws, call('browser_click', {}), {}, ctx); // missing selector → error
  await executeAgentTool(ws, call('save_web_asset', { url: 'http://169.254.169.254/latest/meta-data' }), {}, ctx);
  await executeAgentTool(ws, call('mcp_mail_send', { to: 'x@demo-mail.kr', body: SECRET_VALUE }), {}, ctx);
  await executeAgentTool(ws, call('read_file', { path: 'package.json' }), {}, ctx); // not audited
  // Approval-denied path (recorded by the step loop before execution).
  recordWebActionAudit({
    cqrRoot, sessionId: 'audit-session', tool: 'browser_navigate',
    args: { url: `https://new-domain.demo.kr/?${SECRET_QUERY}` }, outcome: 'approval_denied',
  });

  const ledgerFile = path.join(cqrRoot, 'data', 'audit', 'agent-ledger.jsonl');
  assert.ok(existsSync(ledgerFile), 'ledger written');
  const raw = readFileSync(ledgerFile, 'utf8');
  const events = raw.trim().split(/\r?\n/).map((l) => JSON.parse(l)).filter((e) => e.type === 'web_action');
  const byTool = (tool) => events.filter((e) => e.tool === tool);

  assert.equal(events.length, 8, `8 web_action events (got ${events.length})`);
  assert.equal(raw.includes('"tool":"read_file"'), false, 'local tools not recorded as web_action');

  const [nav, denied] = byTool('browser_navigate');
  assert.deepEqual(
    { target: nav.web.target, action: nav.web.action, host: nav.web.host, outcome: nav.web.outcome },
    { target: 'isolated', action: 'navigate', host: 'shop.demo-store.kr', outcome: 'ok' },
  );
  assert.equal(nav.sessionId, 'audit-session');
  assert.equal(typeof nav.durationMs, 'number');
  assert.deepEqual({ t: denied.web.target, o: denied.web.outcome, h: denied.web.host },
    { t: 'none', o: 'approval_denied', h: 'new-domain.demo.kr' });

  assert.equal(byTool('browser_fill')[0].web.host, 'form.demo-login.kr', 'host taken from result page url');
  assert.equal(byTool('browser_snapshot')[0].web.outcome, 'ok');
  assert.equal(byTool('browser_evaluate')[0].web.target, 'isolated');
  assert.equal(byTool('browser_click')[0].web.outcome, 'error');
  const dl = byTool('save_web_asset')[0];
  assert.deepEqual({ t: dl.web.target, o: dl.web.outcome, h: dl.web.host },
    { t: 'download', o: 'blocked', h: '169.254.169.254' });
  const mcp = byTool('mcp_mail_send')[0];
  assert.equal(mcp.web.target, 'mcp');
  assert.equal(mcp.web.action, 'call');

  // Privacy: values, expressions, queries, page content and MCP args never hit disk.
  for (const mark of [SECRET_VALUE, 'EXPR-MARK-5521', 'QUERY-MARK-7713', PAGE_BODY, 'x@demo-mail.kr', '#pw', '/meta-data']) {
    assert.equal(raw.includes(mark), false, `ledger must not contain ${mark}`);
  }

  // ── 3. Summary ────────────────────────────────────────────────────────────
  const summary = summarizeAgentAuditLedger(cqrRoot);
  assert.equal(summary.web_actions.total, 8);
  assert.equal(summary.web_actions.by_target.isolated, 5);
  assert.equal(summary.web_actions.by_outcome.blocked, 1);
  assert.equal(summary.web_actions.by_outcome.approval_denied, 1);
  assert.ok(summary.web_actions.top_hosts.some((h) => h.host === 'form.demo-login.kr' && h.count === 2));
  assert.match(formatAuditSummaryBrief(summary), /web: .*isolated=5/);

  // ── 4. Kill switch ────────────────────────────────────────────────────────
  process.env.MY_AGENT_WEB_AUDIT = '0';
  recordWebActionAudit({ cqrRoot, tool: 'browser_navigate', args: { url: 'https://off.demo.kr' }, outcome: 'ok' });
  delete process.env.MY_AGENT_WEB_AUDIT;
  assert.equal(readFileSync(ledgerFile, 'utf8').includes('off.demo.kr'), false, 'MY_AGENT_WEB_AUDIT=0 disables');
} finally {
  rmSync(cqrRoot, { recursive: true, force: true });
}

console.log('verify-web-action-audit: ok');
