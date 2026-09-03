#!/usr/bin/env node
/** L3 Shell/UI — path + wiring evidence (ChatPane ≠ titlebar; inAppBrowser). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, OUT_DIR, absFromRepo, argFlag } from '../lib/paths.mjs';
import { runNode } from '../lib/spawn.mjs';
import { isMainModule } from '../lib/is-main.mjs';

function fileHas(rel, needle) {
  const p = absFromRepo(rel);
  if (!p || !existsSync(p)) return { ok: false, path: p, reason: 'missing_file' };
  const text = readFileSync(p, 'utf8');
  return { ok: text.includes(needle), path: p, reason: text.includes(needle) ? null : 'needle_missing' };
}

export async function runL3(opts = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();
  const rows = [];

  const uiFacts = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'core/config/defaults/ui-facts.json'), 'utf8'),
  );
  const checks = [
    { id: 'ui.chat_pane', rel: uiFacts.workspace?.chat_pane, acceptance: 'ChatPane composer path' },
    {
      id: 'ui.confirm_modal',
      rel: uiFacts.workspace?.confirm_modal,
      acceptance: 'ConfirmModal click/confirm path',
    },
    {
      id: 'shell.main_window',
      rel: uiFacts.shell?.main_window,
      acceptance: 'WPF title chrome MainWindow.xaml',
    },
    {
      id: 'ui.target_map',
      rel: 'core/config/defaults/ui-facts.json',
      acceptance: 'titlebar ≠ ChatPane map',
    },
  ];

  for (const c of checks) {
    const p = absFromRepo(c.rel);
    const ok = Boolean(p && existsSync(p));
    rows.push({
      id: c.id,
      ok,
      tag: ok ? 'green' : 'red',
      path: p,
      acceptance: c.acceptance,
      layer: 'L3',
    });
  }

  // Shell integration wiring (AGENTS: <a href> alone ≠ 인앱 열림)
  const uiOpen = fileHas(
    'ui/workspace/src/components/ChatPane.tsx',
    "type: 'inAppBrowser.open'",
  );
  rows.push({
    id: 'ui.inAppBrowser.open_postMessage',
    ok: uiOpen.ok,
    tag: uiOpen.ok ? 'green' : 'red',
    path: uiOpen.path,
    acceptance: 'ChatPane → chrome.webview.postMessage inAppBrowser.open',
    layer: 'L3',
    note: uiOpen.reason,
  });

  const shellCase = fileHas('shell/CqrPa.Shell/MainWindow.xaml.cs', 'case "inAppBrowser.open"');
  rows.push({
    id: 'shell.inAppBrowser.open_handler',
    ok: shellCase.ok,
    tag: shellCase.ok ? 'green' : 'red',
    path: shellCase.path,
    acceptance: 'MainWindow.xaml.cs handles inAppBrowser.open',
    layer: 'L3',
    note: shellCase.reason,
  });

  const navStart = fileHas('shell/CqrPa.Shell/MainWindow.xaml.cs', 'NavigationStarting');
  rows.push({
    id: 'shell.NavigationStarting_inApp',
    ok: navStart.ok,
    tag: navStart.ok ? 'green' : 'red',
    path: navStart.path,
    acceptance: 'NavigationStarting → OpenInAppBrowser path',
    layer: 'L3',
    note: navStart.reason,
  });

  // IMP-UI-01: ChatPane context gauge (composer meta — not titlebar)
  const gauge = fileHas(
    'ui/workspace/src/components/ChatPane.tsx',
    'data-testid="context-budget-gauge"',
  );
  rows.push({
    id: 'ui.context_budget_gauge',
    ok: gauge.ok,
    tag: gauge.ok ? 'green' : 'red',
    path: gauge.path,
    acceptance: 'ChatPane composer context-budget-gauge',
    layer: 'L3',
    note: gauge.reason,
  });

  // IMP-UI-02: titlebar must NOT host the gauge
  const titlebarFiles = [
    'shell/CqrPa.Shell/MainWindow.xaml',
    'shell/CqrPa.Shell/MainWindow.xaml.cs',
    'shell/CqrPa.Shell/DarkTitleBar.cs',
  ];
  let titlebarLeak = false;
  for (const rel of titlebarFiles) {
    const hit = fileHas(rel, 'context-budget-gauge');
    if (hit.ok) titlebarLeak = true;
  }
  rows.push({
    id: 'ui.gauge_not_in_titlebar',
    ok: !titlebarLeak,
    tag: titlebarLeak ? 'red' : 'green',
    acceptance: 'context-budget-gauge absent from titlebar paths',
    layer: 'L3',
  });

  // IMP-API-01: lab/FPV clients use a single session header key
  const httpChat = fileHas('tools/fpv/lib/http-chat.mjs', 'Single x-cqr-session header only');
  const httpChatKey = fileHas('tools/fpv/lib/http-chat.mjs', "'x-cqr-session'");
  rows.push({
    id: 'api.session_header_single',
    ok: httpChat.ok && httpChatKey.ok,
    tag: httpChat.ok && httpChatKey.ok ? 'green' : 'red',
    acceptance: 'FPV http-chat uses only x-cqr-session',
    layer: 'L3',
  });

  if (opts.browser || argFlag('--browser')) {
    const smoke = runNode('tools/lab/product-browser-smoke.mjs');
    rows.push({
      id: 'product-browser-smoke',
      ok: smoke.ok,
      tag: smoke.ok ? 'green' : 'red',
      layer: 'L3',
    });
  } else {
    rows.push({
      id: 'product-browser-smoke',
      ok: true,
      tag: 'explicit_skip',
      layer: 'L3',
      note: 'pass --browser to enable',
    });
  }

  const ok = rows.filter((r) => r.tag !== 'explicit_skip').every((r) => r.ok);
  const report = {
    layer: 'L3',
    started,
    finished: new Date().toISOString(),
    ok,
    rows,
  };
  writeFileSync(path.join(OUT_DIR, 'l3-shell-ui.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (isMainModule(import.meta.url)) {
  runL3()
    .then((r) => {
      console.log(`=== FPV L3 ok=${r.ok} ===`);
      for (const row of r.rows) {
        console.log(`  ${row.tag} ${row.id} ${row.acceptance || row.note || ''}`);
      }
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
