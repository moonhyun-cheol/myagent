import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { VisibleBrowserBridge } from '../core/dist/browser/visible-browser-bridge.js';

const root = new URL('../', import.meta.url);
const read = async (relative) => readFile(new URL(relative, root), 'utf8');

const [definitions, executor, shellAutomation, shellTabs, shellClient, workspaceBridge, browserPane] = await Promise.all([
  read('core/src/agent/agent-tool-definitions.ts'),
  read('core/src/agent/agent-tool-execute.ts'),
  read('shell/CqrPa.Shell/MainWindow.VisibleBrowserAutomation.cs'),
  read('shell/CqrPa.Shell/MainWindow.BrowserTabs.cs'),
  read('shell/CqrPa.Shell/VisibleBrowserAutomationClient.cs'),
  read('ui/workspace/src/lib/inAppBrowserBridge.ts'),
  read('ui/workspace/src/components/BrowserPane.tsx'),
]);

for (const name of ['browser_targets', 'browser_lock', 'browser_unlock', 'browser_snapshot', 'browser_drag']) {
  assert.match(definitions, new RegExp(`name: '${name}'`), `${name} must be in the builtin browser tool catalog`);
}
assert.match(definitions, /enum: \['visible', 'isolated'\]/, 'browser tools must expose explicit visible/isolated targets');
assert.match(executor, /VISIBLE_BROWSER_RAW_EVALUATE_FORBIDDEN/, 'raw evaluate must be rejected for visible target');
assert.match(executor, /assertLockedBy\(ctx\?\.sessionId/, 'visible mutations must require the session lock');
assert.match(executor, /tab\.control\.acquire/, 'acquiring a lease must publish tab control state to the shell');
assert.match(executor, /tab\.control\.release/, 'releasing a lease must clear shell tab control state');
assert.match(shellAutomation, /Accessibility\.getFullAXTree/, 'visible snapshot must use the accessibility tree');
assert.match(shellAutomation, /STALE_BROWSER_REF/, 'stale snapshot refs must be rejected');
assert.match(shellAutomation, /PASSWORD_FIELD_BLOCKED/, 'password filling must be blocked');
assert.match(shellAutomation, /Input\.dispatchMouseEvent/, 'visible drag must dispatch trusted CDP mouse input');
assert.match(shellAutomation, /"drag" => await AutomateBrowserDragAsync/, 'shell must route visible drag commands');
assert.match(shellAutomation, /VISIBLE_BROWSER_CONTROL_TAKEN_OVER/, 'automation must stop after user takeover');
assert.match(shellTabs, /VISIBLE_BROWSER_TAB_CONTROLLED/, 'controlled tabs must be protected from closing');
assert.match(shellTabs, /returnTabId = _browserReturnTabId/, 'shell state must retain the observation return tab');
assert.match(workspaceBridge, /inAppBrowser\.tab\.takeOver/, 'workspace bridge must expose user takeover');
assert.match(workspaceBridge, /inAppBrowser\.tab\.return/, 'workspace bridge must expose return from observation');
assert.match(browserPane, /제어 가져오기/, 'browser pane must expose the takeover action');
assert.match(browserPane, /원래 탭으로/, 'browser pane must expose the observation return action');
assert.doesNotMatch(shellAutomation, /\bWebView\.CoreWebView2\b/, 'workspace WebView must never be an automation target');
assert.match(shellClient, /my-agent-visible-browser-\{port\}/, 'shell and core must share the private pipe naming contract');
assert.match(shellClient, /messageType == "cancel"/, 'shell must accept core cancellation messages');
assert.match(shellClient, /VISIBLE_BROWSER_COMMAND_TIMEOUT/, 'shell commands must have a bounded execution time');
assert.match(shellClient, /_writerGate/, 'concurrent shell responses must serialize pipe writes');
assert.match(shellAutomation, /BrowserAutomationCachedState/, 'targets must use a dispatcher-independent state cache');

const port = 30_000 + (process.pid % 20_000);
const bridge = new VisibleBrowserBridge(port, 200);
bridge.start();
const pipePath = process.platform === 'win32'
  ? `\\\\.\\pipe\\my-agent-visible-browser-${port}`
  : `/tmp/my-agent-visible-browser-${port}.sock`;

const connect = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(pipePath, () => resolve(socket));
        socket.once('error', reject);
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('fake shell could not connect to visible browser bridge');
};

const socket = await connect();
let buffer = '';
const cancelled = new Set();
let hangingId = '';
socket.setEncoding('utf8');
socket.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === 'cancel') {
      cancelled.add(command.id);
      continue;
    }
    if (command.action === 'hang') {
      hangingId = command.id;
      continue;
    }
    if (command.action === 'shell-timeout') {
      socket.write(`${JSON.stringify({ type: 'result', id: command.id, ok: false, error: 'VISIBLE_BROWSER_COMMAND_TIMEOUT' })}\n`);
      continue;
    }
    socket.write(`${JSON.stringify({ type: 'result', id: command.id, ok: true, result: { action: command.action } })}\n`);
  }
});

for (let attempt = 0; attempt < 30 && !bridge.isConnected(); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(bridge.isConnected(), true);
assert.deepEqual(await bridge.request('targets'), { action: 'targets' });
const mainLock = bridge.lockFor('session-a');
assert.equal(mainLock.owner, 'session-a');
assert.equal(mainLock.tab_id, 'main', 'a missing tab id resolves to the default tab');
bridge.assertLockedBy('session-a');
assert.throws(() => bridge.assertLockedBy('session-b'), /VISIBLE_BROWSER_LOCKED:session-a/);
// Each tab keeps an independent lease so multi-tab sessions do not collide.
assert.equal(bridge.lockFor('session-b', 'tab-2').tab_id, 'tab-2');
bridge.assertLockedBy('session-b', 'tab-2');
bridge.assertLockedBy('session-a');
assert.deepEqual(bridge.unlockFor('session-a'), { unlocked: true, tab_id: 'main' });
assert.throws(() => bridge.assertLockedBy('session-a'), /VISIBLE_BROWSER_LOCK_REQUIRED/);
assert.deepEqual(bridge.unlockFor('session-b', 'tab-2'), { unlocked: true, tab_id: 'tab-2' });
assert.throws(() => bridge.assertLockedBy('session-b', 'tab-2'), /VISIBLE_BROWSER_LOCK_REQUIRED/);

await assert.rejects(bridge.request('shell-timeout'), /VISIBLE_BROWSER_COMMAND_TIMEOUT/);
assert.equal(bridge.status().degraded, true, 'a shell-side timeout must mark the bridge as degraded');
assert.deepEqual(await bridge.request('targets'), { action: 'targets' });
assert.equal(bridge.status().degraded, false, 'a successful health response must clear shell-side degradation');

await assert.rejects(bridge.request('hang'), /VISIBLE_BROWSER_TIMEOUT:hang/);
for (let attempt = 0; attempt < 30 && !cancelled.has(hangingId); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.ok(hangingId, 'the hanging command id must be observed');
assert.ok(cancelled.has(hangingId), 'core timeout must send a shell cancellation message');
assert.equal(bridge.status().degraded, true, 'a timeout must mark the live transport as degraded');
assert.match(bridge.status().restart_hint ?? '', /다시 시작/, 'degraded state must include a restart hint');
assert.deepEqual(await bridge.request('targets'), { action: 'targets' });
assert.equal(bridge.status().degraded, false, 'a later shell response must clear degraded state');

socket.destroy();
bridge.stop();
console.log('verify-visible-browser-bridge: ok');
