import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';

const root = new URL('../', import.meta.url);
const read = async (relative) => readFile(new URL(relative, root), 'utf8');

const visibleLock = {
  id: 'background-visible-lock',
  type: 'function',
  function: { name: 'browser_lock', arguments: JSON.stringify({ target: 'visible' }) },
};

const blocked = await executeAgentTool(
  process.cwd(),
  visibleLock,
  {},
  { browserRouting: 'background', sessionId: 'routing-test' },
);
assert.match(
  blocked.output,
  /BACKGROUND_VISIBLE_BROWSER_FORBIDDEN/,
  'background work must not acquire or drive a visible browser tab',
);

const [apiServer, workspaceAgent, shell, feed, bridge] = await Promise.all([
  read('core/src/api-server.ts'),
  read('core/src/chat/modes/workspace-agent.ts'),
  read('shell/CqrPa.Shell/MainWindow.xaml.cs'),
  read('ui/workspace/src/components/AutomationFeedModal.tsx'),
  read('ui/workspace/src/lib/inAppBrowserBridge.ts'),
]);

assert.match(apiServer, /execution_context:\s*'background'/, 'scheduler must mark executions as background');
assert.match(workspaceAgent, /playwrightHeadless:\s*browserRouting === 'background' \? true/, 'background browser must be headless');
assert.match(shell, /inAppBrowser\.tab\.promote/, 'shell must expose explicit promotion');
assert.match(feed, /탭으로 보기/, 'automation feed must expose the promotion action');
assert.match(bridge, /inAppBrowser\.tab\.promote/, 'workspace bridge must send promotion commands');

console.log('verify-browser-routing: ok');
