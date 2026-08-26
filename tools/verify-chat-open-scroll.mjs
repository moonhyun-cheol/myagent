#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const chatPane = readFileSync(
  path.join(root, 'ui/workspace/src/components/ChatPane.tsx'),
  'utf8',
);

assert.match(chatPane, /useLayoutEffect\(\(\) => \{/);
assert.match(chatPane, /openedSessionRef\.current === activeSessionId/);
assert.match(chatPane, /scroller\.scrollTop = scroller\.scrollHeight/);
assert.match(chatPane, /\[activeSessionId, chat\.length\]/);
assert.doesNotMatch(chatPane, /\[activeSessionId, chat\]/);

console.log('chat open latest-position contract: PASS');
