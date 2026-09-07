import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';
import { loadAgentRunMeta, setSessionTodoLedger } from '../core/dist/agent/agent-run-meta.js';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const main = read('ui/workspace/src/components/MainWorkspaceContainer.tsx');
assert.doesNotMatch(main, /extractTodoItems|cleanTodoLabel|sourceTurn|checklistItems/);
assert.match(main, /useSessionTodos\(activeSessionId, busy\)/);
const dispatch = read('core/src/routes/dispatch.ts');
const route = dispatch.slice(dispatch.indexOf('      const sessionTodoMatch'), dispatch.indexOf('      const sessionModelMatch'));
const runRoute = new Function(
  'url',
  'method',
  'sessionStore',
  'loadAgentRunMeta',
  'cqrRoot',
  'res',
  'sendJson',
  'decodeURIComponent',
  `${route}\nreturn undefined;`,
);
const temp = mkdtempSync(path.join(os.tmpdir(), 'todo-view-'));
try {
  const todos = ['pending', 'doing', 'done', 'blocked'].map((status, i) => ({ id: String(i), text: 'task ' + i, status, evidenceRefs: [] }));
  setSessionTodoLedger(temp, 'a', { version: 1, todos, retainEvidence: [], workingNotes: [], updatedAt: new Date().toISOString() });
  const call = id => runRoute(new URL('http://test/sessions/' + id + '/todos'), 'GET', { load: sid => ['a', 'b'].includes(sid) }, loadAgentRunMeta, temp, { setHeader() {} }, (_, status, body) => ({ status, body }), decodeURIComponent);
  assert.deepEqual(call('a').body.todos, todos);
  assert.deepEqual(call('b').body.todos, []);
  assert.equal(call('missing').status, 404);
  assert.equal(call('a').body.workingNotes, undefined);
} finally { rmSync(temp, { recursive: true, force: true }); }
// Execute the real hook with a small deterministic React/effect harness.
const source = read('ui/workspace/src/lib/useSessionTodos.ts');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
let state, effect, dependencies, cleanup;
let requests = [];
const timers = new Map(); let timerId = 0;
const react = {
  useState(initial) { if (state === undefined) state = initial; return [state, value => { state = value; }]; },
  useEffect(fn, deps) { if (!dependencies || deps.some((d, i) => d !== dependencies[i])) { cleanup?.(); dependencies = deps; effect = fn; } },
};
const exports = {};
new Function('require', 'exports', 'AbortController', 'setTimeout', 'clearTimeout', js)(name => name === 'react' ? react : { fetchSessionTodos: (id, signal) => new Promise((resolve, reject) => requests.push({ id, signal, resolve, reject })) }, exports, AbortController, (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, id => timers.delete(id));
const render = (id, busy) => { const result = exports.useSessionTodos(id, busy); if (effect) { const fn = effect; effect = null; cleanup = fn(); } return result; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
assert.deepEqual(render('a', true).items, []);
requests[0].resolve([{ id: 't', text: 'model task', status: 'doing' }]); await flush();
assert.equal(render('a', true).items[0].status, 'active');
assert.equal([...timers.values()][0].ms, 1000);
assert.deepEqual(render('b', true).items, []);
assert.ok(requests[0].signal.aborted);
requests[1].resolve([]); await flush();
assert.deepEqual(render('b', true).items, []);
render('a', false); requests[2].resolve([{ id: 't', text: 'unchanged', status: 'doing' }]); await flush();
assert.equal(render('a', false).items[0].status, 'active', 'busy must not infer status');
assert.equal([...timers.values()][0].ms, 5000);
render('b', false); const late = requests[3]; render('c', false);
late.resolve([{ id: 'wrong', text: 'old session', status: 'done' }]); await flush();
assert.deepEqual(render('c', false).items, []);
requests[4].reject(new Error('offline')); await flush();
assert.match(render('c', false).error, /불러오지/);
assert.deepEqual(render(null, false).items, []);
cleanup?.(); assert.equal(timers.size, 0);
console.log('verify-sidebar-todos: PASS (route persistence/isolation/404; hook statuses/polling/switch/race/error/cleanup; no prose parser)');
