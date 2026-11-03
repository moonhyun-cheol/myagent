#!/usr/bin/env node
// 「문제 해결」 summary: shell/API logs -> plain-language problem groups (core/src/runtime/problem-history.ts).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const mod = await import(pathToFileURL(path.join(root, 'core/dist/runtime/problem-history.js')).href);
let passed = 0;
const pass = (name) => { passed += 1; console.log(`PASS ${name}`); };

const now = new Date('2026-11-03T12:00:00.000Z');

// 1. Ordinary lines are not problems.
assert.equal(mod.classifyShellMessage('startup: main window shown'), null);
assert.equal(mod.classifyShellMessage('api: started node pid=1 port=3000'), null);
assert.equal(mod.classifyShellMessage('system_gap: watchdog paused 300s (PC 절전 가능)'), null);
assert.equal(mod.classifyApiMessage('start node=v22 port=3000'), null);
assert.equal(mod.classifyApiMessage('event_loop_stall ms=4000 rss_mb=100'), null, 'short stalls are noise');
pass('ordinary lines ignored');

// 2. Shell log parsing (local offset timestamps, multi-line exceptions).
const shell = [
  '2026-11-03 20:00:00.000 +09:00 pid=10 startup: main window shown',
  '2026-11-03 20:01:00.000 +09:00 pid=10 webview_process_failed: kind=BrowserProcessExited shell ws_mb=1',
  '2026-11-03 20:01:05.000 +09:00 pid=10 webview_recovery: 화면 엔진 다시 만들기 (BrowserProcessExited)',
  '2026-11-03 20:02:00.000 +09:00 pid=10 ui_hang: 화면 스레드가 7초째 응답 없음 shell ws_mb=1',
  '2026-11-03 20:03:00.000 +09:00 pid=10 dispatcher unhandled exception: System.InvalidOperationException: boom',
  '   at Foo.Bar()',
  '2026-11-03 20:04:00.000 +09:00 pid=11 startup: api start failed kind=FilesMissing (node.exe 없음)',
  '2026-11-03 20:04:00.500 +09:00 pid=11 problem_shown: 프로그램 파일 일부가 없습니다 | 백신 프로그램이 파일을 격리했을 수 있습니다.',
  '2026-11-03 20:05:00.000 +09:00 pid=12 startup: api start failed kind=Other (spawn failed)',
  '2026-11-03 20:05:00.200 +09:00 pid=12 problem_shown: MY Agent를 시작하지 못했습니다 | 디스크 여유 공간이 부족합니다 (약 120MB).',
  '2026-11-03 20:06:00.000 +09:00 pid=13 startup: api start failed kind=Blocked (Access is denied)',
  'garbage line',
].join('\r\n');
const shellEvents = mod.parseShellLog(shell);
assert.deepEqual(shellEvents.map((e) => e.kind), ['screen_crash', 'app_hang', 'app_error', 'startup_failed', 'startup_failed', 'startup_failed']);
assert.equal(shellEvents[0].at, '2026-11-03T11:01:00.000Z');
assert.equal(shellEvents[1].detail, '7초 넘게 멈춤');
assert.equal(shellEvents[2].detail, 'System.InvalidOperationException: boom');
assert.equal(shellEvents[3].detail, 'node.exe 없음');
assert.equal(shellEvents[3].cause, '백신 프로그램이 파일을 격리했을 수 있습니다.', 'dialog cause wins');
assert.match(shellEvents[3].advice, /다시 설치/);
assert.match(shellEvents[4].cause, /디스크/);
assert.match(shellEvents[4].advice, /디스크 여유 공간/);
assert.equal(shellEvents[3].download_url, 'https://github.com/moonhyun-cheol/myagent/releases/latest', 'reinstall links the installer page');
assert.equal(shellEvents[4].download_url, undefined, 'disk problems do not offer reinstall');
assert.equal(shellEvents[5].download_url, undefined, 'blocked start does not offer reinstall');
{
  const g = mod.summarizeProblems([shellEvents[3]], { days: 3650, now: new Date('2026-11-04T00:00:00Z') }).groups[0];
  assert.equal(g.download_url, 'https://github.com/moonhyun-cheol/myagent/releases/latest', 'group carries download_url');
}
assert.match(shellEvents[5].cause, /백신 프로그램이나 보안 정책/, 'kind fallback without dialog');
assert.doesNotMatch(JSON.stringify(shellEvents), /그때 표시된 안내 창/);
pass('shell log parse');

// 3. API runtime log parsing (crash stack head, long stall).
const api = [
  '2026-11-03T10:00:00.000Z pid=20 start node=v22 port=3000',
  '2026-11-03T10:05:00.000Z pid=20 crash origin=uncaughtException uptime_s=300 rss_mb=1',
  'Error: listen EADDRINUSE: address already in use',
  '    at Server.listen',
  '2026-11-03T10:05:00.100Z pid=20 exit code=1 uptime_s=300 rss_mb=1',
  '2026-11-03T10:06:00.000Z pid=21 event_loop_stall ms=15000 rss_mb=1',
].join('\n');
const apiEvents = mod.parseApiRuntimeLog(api);
assert.deepEqual(apiEvents.map((e) => e.kind), ['service_crash', 'service_stall']);
assert.equal(apiEvents[0].detail, 'Error: listen EADDRINUSE: address already in use');
assert.equal(apiEvents[1].detail, '약 15초');
pass('api log parse');

// 4. Summary: ok / recovered / attention + repeat escalation + range filter.
const empty = mod.summarizeProblems([], { days: 14, now });
assert.equal(empty.status, 'ok');
assert.match(empty.headline, /문제가 없습니다/);

const recoveredOnly = mod.summarizeProblems(
  [{ at: '2026-11-03T11:00:00.000Z', kind: 'screen_crash' }, { at: '2026-11-03T11:30:00.000Z', kind: 'service_restart' }],
  { days: 14, now },
);
assert.equal(recoveredOnly.status, 'recovered');
assert.match(recoveredOnly.headline, /2번.*자동으로 해결/);

const repeated = mod.summarizeProblems(
  [1, 2, 3].map((h) => ({ at: `2026-11-0${h}T10:00:00.000Z`, kind: 'screen_crash' })),
  { days: 14, now },
);
assert.equal(repeated.status, 'attention', 'repeated recovered problem needs a look');
assert.equal(repeated.groups[0].severity, 'warn');
assert.equal(repeated.groups[0].count, 3);
assert.equal(repeated.groups[0].last_at, '2026-11-03T10:00:00.000Z');
assert.equal(repeated.groups[0].first_at, '2026-11-01T10:00:00.000Z');
assert.match(repeated.groups[0].advice, /WebView2/);

const mixed = mod.summarizeProblems(
  [
    { at: '2026-11-03T11:00:00.000Z', kind: 'screen_crash' },
    { at: '2026-11-03T09:00:00.000Z', kind: 'service_gave_up' },
    { at: '2026-11-03T09:00:00.000Z', kind: 'service_gave_up' },
    { at: '2026-09-01T09:00:00.000Z', kind: 'app_error' },
  ],
  { days: 14, now },
);
assert.deepEqual(mixed.groups.map((g) => g.kind), ['service_gave_up', 'screen_crash'], 'errors first, old events dropped');
assert.equal(mixed.groups[0].count, 1, 'exact duplicate removed');
assert.equal(mixed.recent[0].kind, 'screen_crash', 'recent newest first');
pass('summary status/grouping');

// 4b. Crash + automatic restart is one incident; an unrecovered crash stays visible.
const incident = mod.summarizeProblems(
  [
    { at: '2026-11-03T10:00:00.000Z', kind: 'service_crash', detail: 'Error: boom' },
    { at: '2026-11-03T10:00:20.000Z', kind: 'service_restart' },
    { at: '2026-11-03T11:00:00.000Z', kind: 'service_crash' },
  ],
  { days: 14, now },
);
assert.deepEqual(incident.groups.map((g) => g.kind).sort(), ['service_crash', 'service_restart']);
const restartGroup = incident.groups.find((g) => g.kind === 'service_restart');
assert.equal(restartGroup.count, 1);
assert.equal(restartGroup.severity, 'recovered');
assert.equal(incident.recent.find((e) => e.kind === 'service_restart').detail, 'Error: boom', 'crash detail carried');
assert.equal(incident.groups.find((g) => g.kind === 'service_crash').count, 1, 'only the unrecovered crash remains');
const recoveredIncident = mod.summarizeProblems(
  [
    { at: '2026-11-03T10:00:00.000Z', kind: 'service_crash' },
    { at: '2026-11-03T10:00:20.000Z', kind: 'service_restart' },
  ],
  { days: 14, now },
);
assert.equal(recoveredIncident.status, 'recovered', 'no "확인 권장" next to "자동 해결" for one incident');
assert.match(recoveredIncident.headline, /1번/);

// 4c. A single past startup failure is 확인 권장 with its cause; repeats need help.
const once = mod.summarizeProblems([{ at: '2026-11-03T10:00:00.000Z', kind: 'startup_failed', cause: 'C', advice: 'A' }], { days: 14, now });
assert.equal(once.groups[0].severity, 'warn');
assert.equal(once.groups[0].cause, 'C');
assert.equal(once.groups[0].advice, 'A');
const twice = mod.summarizeProblems(
  ['10', '11'].map((h) => ({ at: `2026-11-03T${h}:00:00.000Z`, kind: 'startup_failed' })),
  { days: 14, now },
);
assert.equal(twice.groups[0].severity, 'error');
pass('incident merge + startup cause');

// 5. loadProblemHistory reads the real file layout (missing files are fine).
const tmp = mkdtempSync(path.join(os.tmpdir(), 'problem-history-'));
try {
  mkdirSync(path.join(tmp, 'data', 'logs'), { recursive: true });
  mkdirSync(path.join(tmp, 'logs'), { recursive: true });
  writeFileSync(path.join(tmp, 'data', 'logs', 'shell-startup.log'), shell, 'utf8');
  writeFileSync(path.join(tmp, 'logs', 'api-runtime.log'), api, 'utf8');
  const doc = mod.loadProblemHistory(tmp, { days: 14, now, env: {} });
  assert.equal(doc.sources_found, 2);
  assert.equal(doc.status, 'attention');
  assert.equal(doc.groups[0].severity, 'error');
  assert.ok(doc.groups.some((g) => g.kind === 'service_crash'));
  const none = mod.loadProblemHistory(path.join(tmp, 'missing'), { now, env: {} });
  assert.equal(none.status, 'ok');
  assert.equal(none.sources_found, 0);
  assert.equal(mod.loadProblemHistory(tmp, { days: 9999, now, env: {} }).days, 90, 'days clamped');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
pass('load from disk');

console.log(`verify-problem-history: ${passed} passed`);
