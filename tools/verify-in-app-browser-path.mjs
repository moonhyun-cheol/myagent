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

mustInclude('ui/workspace/src/components/ChatPane.tsx', [
  "type: 'inAppBrowser.open'",
  'webview.postMessage',
]);
mustInclude('shell/CqrPa.Shell/MainWindow.xaml.cs', [
  'case "inAppBrowser.open"',
  'OpenInAppBrowser',
]);
mustInclude('shell/CqrPa.Shell/MainWindow.xaml', ['InAppBrowserPanel']);

console.log('verify-in-app-browser-path: PASS (structural call-path witness)');
console.log('manual: launch START.bat → chat https link click → right browser panel visible');
