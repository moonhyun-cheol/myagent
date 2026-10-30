#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mustInclude(rel, needles) {
  const abs = path.join(root, rel);
  assert.ok(existsSync(abs), `missing ${rel}`);
  const text = readFileSync(abs, 'utf8');
  for (const needle of needles) {
    assert.ok(text.includes(needle), `${rel} missing ${JSON.stringify(needle)}`);
  }
}

function mustExclude(rel, needles) {
  const text = readFileSync(path.join(root, rel), 'utf8');
  for (const needle of needles) {
    assert.ok(!text.includes(needle), `${rel} must not contain ${JSON.stringify(needle)}`);
  }
}

mustInclude('ui/workspace/src/components/ChatPane.tsx', [
  'openInAppBrowser',
]);
mustInclude('ui/workspace/src/lib/inAppBrowserBridge.ts', [
  "type: 'inAppBrowser.open'",
  'webview.postMessage',
]);
mustInclude('ui/workspace/src/components/BrowserPane.tsx', [
  'openInAppBrowser',
  'inAppBrowserBridge',
  'normalizeBrowserUrl',
]);
mustInclude('shell/CqrPa.Shell/MainWindow.xaml.cs', [
  'case "inAppBrowser.open"',
  'OpenInAppBrowser',
  'await EnsureBrowserAsync(EnsurePrimaryTab());',
]);
mustInclude('shell/CqrPa.Shell/MainWindow.BrowserTabs.cs', [
  'DeleteBrowserCdpPortFile();',
  'if (!tab.Requested)',
]);
// The user-facing WebView2 must not expose CDP: agent control goes through the shell pipe only.
mustExclude('shell/CqrPa.Shell/MainWindow.BrowserTabs.cs', [
  '--remote-debugging-port',
  'PublishBrowserCdpPort',
]);
mustInclude('shell/CqrPa.Shell/MainWindow.xaml', ['InAppBrowserPanel', 'Visibility="Collapsed"']);
mustInclude('core/src/agent/agent-tool-registry.ts', [
  '[...CODE_AGENT_TOOLS, ...BROWSER_AGENT_TOOLS]',
  'getCodeAgentToolsForPack(pack, true, cqrRoot)',
]);
mustInclude('core/src/agent/agent-tool-definitions.ts', [
  "name: 'browser_navigate'",
  "name: 'browser_snapshot'",
  "name: 'browser_click'",
]);
mustInclude('core/src/browser/playwright-session.ts', ['pw.chromium.launch(']);
mustExclude('core/src/browser/playwright-session.ts', [
  'connectOverCDP',
  'in-app-browser-cdp-port.txt',
  'sharedWebView',
]);
mustExclude('core/src/agent/agent-run-loop.ts', ['preferSharedWebView', 'usesSharedWebView']);

console.log('verify-in-app-browser-path: PASS (tool schema + pipe-only visible WebView2, no CDP)');
console.log('manual: launch app → Agent navigate/snapshot/click (visible) → confirm the same page in the opened panel');
