#!/usr/bin/env node
// Golden: session temp GC P0–P2
//   1. chat delete drops exclusive files, keeps other-chat refs
//   2. files still in remaining messages are kept (no version-cap)
//   3. orphans not in any message are removed
//   4. fetch-cache uses age + size cap only; not wiped on session delete
//   5. .playwright/ is appended to workspace gitignore
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const gcMod = await import(
  pathToFileURL(path.join(repo, 'core', 'dist', 'sessions', 'session-temp-gc.js')).href
);
const giMod = await import(
  pathToFileURL(path.join(repo, 'core', 'dist', 'sessions', 'workspace-scratch-gitignore.js')).href
);
const {
  collectLiveTempRefs,
  gcDeletedSessionTemp,
  pruneSessionTemp,
  resolveSessionTempGcPolicy,
  sweepSessionTemp,
} = gcMod;
const { ensurePlaywrightGitignore, removePlaywrightSessionDir } = giMod;

const scratchRoot = path.join(repo, 'data', 'outputs', 'verify-session-temp-gc');
mkdirSync(scratchRoot, { recursive: true });
const cqrRoot = mkdtempSync(path.join(scratchRoot, 'run-'));

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  OK   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function seedOutput(kind, sessionId, filename, body = 'x') {
  const dir = path.join(cqrRoot, 'data', 'outputs', kind, sessionId);
  mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, filename);
  writeFileSync(fp, body);
  return fp;
}

function sessionRec(id, urls) {
  return {
    id,
    title: id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    messages: [
      {
        role: 'assistant',
        content: urls.map((u) => `see ${u}`).join('\n'),
        at: new Date().toISOString(),
        image_urls: urls.filter((u) => u.includes('/outputs/images/') || u.includes('/outputs/web/')),
      },
    ],
  };
}

const refs = collectLiveTempRefs([
  {
    role: 'assistant',
    content: '/outputs/web/s1/ref.png /attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    at: 't',
    image_urls: ['/outputs/images/s1/a.png'],
  },
]);
check('parses web output URL', refs.outputs.has('web/s1/ref.png'));
check('parses image_urls', refs.outputs.has('images/s1/a.png'));
check('parses attachment id', refs.attachments.has('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));

seedOutput('images', 'chat-a', 'gone.png', 'gone');
seedOutput('web', 'chat-a', 'page.txt', 'txt');
const shared = seedOutput('images', 'chat-a', 'shared.png', 'shared');
const cacheDir = path.join(cqrRoot, 'data', 'outputs', 'browser', 'fetch-cache');
mkdirSync(cacheDir, { recursive: true });
const cacheFp = path.join(cacheDir, 'page.json');
writeFileSync(cacheFp, '{}');
const other = sessionRec('chat-b', ['/outputs/images/chat-a/shared.png']);
const del = gcDeletedSessionTemp(cqrRoot, 'chat-a', [other]);
check('delete removes unreferenced image', !existsSync(path.join(cqrRoot, 'data', 'outputs', 'images', 'chat-a', 'gone.png')));
check('delete removes web download', !existsSync(path.join(cqrRoot, 'data', 'outputs', 'web', 'chat-a', 'page.txt')));
check('delete keeps other-chat ref', existsSync(shared));
check('delete does not wipe fetch-cache', existsSync(cacheFp));
check('delete reports keptShared', del.keptShared >= 1, `n=${del.keptShared}`);

seedOutput('images', 'live', 'visible.png', 'vis');
seedOutput('images', 'live', 'orphan.png', 'orph');
const liveSelf = sessionRec('live', ['/outputs/images/live/visible.png']);
pruneSessionTemp(cqrRoot, 'live', [liveSelf, other]);
check('visible chat image is kept', existsSync(path.join(cqrRoot, 'data', 'outputs', 'images', 'live', 'visible.png')));
check('orphan not in messages is removed', !existsSync(path.join(cqrRoot, 'data', 'outputs', 'images', 'live', 'orphan.png')));

seedOutput('browser', 'ghost', 'shot.png', 'shot');
sweepSessionTemp(cqrRoot, [liveSelf, other]);
check(
  'sweep drops leftover session with no JSON',
  !existsSync(path.join(cqrRoot, 'data', 'outputs', 'browser', 'ghost', 'shot.png')),
);

const staleCache = path.join(cacheDir, 'old.json');
writeFileSync(staleCache, 'old');
const nowSec = Date.now() / 1000;
utimesSync(staleCache, nowSec - 20 * 86400, nowSec - 20 * 86400);
const policy = { fetchCacheMaxAgeMs: 7 * 86400000, fetchCacheMaxBytes: 1024 * 1024 };
sweepSessionTemp(cqrRoot, [liveSelf, other], { policy, now: Date.now() });
check('fetch-cache drops files older than max age', !existsSync(staleCache));
check('fresh fetch-cache file is kept under age cap', existsSync(cacheFp));

rmSync(cacheDir, { recursive: true, force: true });
mkdirSync(cacheDir, { recursive: true });
const bigOld = path.join(cacheDir, 'big-old.json');
const bigNew = path.join(cacheDir, 'big-new.json');
writeFileSync(bigOld, Buffer.alloc(80 * 1024, 1));
writeFileSync(bigNew, Buffer.alloc(80 * 1024, 2));
utimesSync(bigOld, nowSec - 3600, nowSec - 3600);
utimesSync(bigNew, nowSec - 10, nowSec - 10);
sweepSessionTemp(cqrRoot, [liveSelf], {
  policy: { fetchCacheMaxAgeMs: 7 * 86400000, fetchCacheMaxBytes: 100 * 1024 },
  now: Date.now(),
});
check('fetch-cache size cap drops oldest', !existsSync(bigOld));
check('fetch-cache size cap keeps newest', existsSync(bigNew));

const def = resolveSessionTempGcPolicy({});
check('default fetch-cache age is 7 days', def.fetchCacheMaxAgeMs === 7 * 86400000);
check('default fetch-cache cap is 200MB', def.fetchCacheMaxBytes === 200 * 1024 * 1024);

const ws = mkdtempSync(path.join(scratchRoot, 'ws-'));
ensurePlaywrightGitignore(ws);
const gi = readFileSync(path.join(ws, '.gitignore'), 'utf8');
check('workspace gitignore gets .playwright/', gi.includes('.playwright/'));
ensurePlaywrightGitignore(ws);
const gi2 = readFileSync(path.join(ws, '.gitignore'), 'utf8');
check('gitignore is not duplicated', gi2.split('.playwright/').length === gi.split('.playwright/').length);
mkdirSync(path.join(ws, '.playwright', 'sid1'), { recursive: true });
writeFileSync(path.join(ws, '.playwright', 'sid1', 'a.png'), 'x');
removePlaywrightSessionDir(ws, 'sid1');
check('playwright session dir is removed', !existsSync(path.join(ws, '.playwright', 'sid1', 'a.png')));

rmSync(scratchRoot, { recursive: true, force: true });

if (failed > 0) {
  console.error(`verify-session-temp-gc FAILED (${failed})`);
  process.exit(1);
}
console.log('verify-session-temp-gc OK');
