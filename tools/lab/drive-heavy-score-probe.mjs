#!/usr/bin/env node
/**
 * Heavy score probe: market report + app in ONE web_dev turn.
 */
import { createWriteStream, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const API_HOST = '127.0.0.1';
const API_PORT = Number(process.env.MY_AGENT_API_PORT || 10200);
const WORKSPACE =
  process.env.CQR_EVAL_WORKSPACE || 'C:\\Users\\Temp\\Desktop\\현철\\코딩연습\\cqr_heavy_probe';
const outDir = path.join(WORKSPACE, '_score_eval');
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(outDir, { recursive: true });

const MESSAGE = `web_dev AGENT. 빈 워크스페이스에 「구독형 도시락 브랜드」용 산출물을 한 번에 완성해. write_file/edit_file만.

필수 (디스크):
1) index.html + styles.css + app.js
   - 도시락 메뉴 카드 3개 이상, 관심 구독 메모 입력, localStorage
   - 간단 견적(인원×단가) 표시
2) docs/MARKET_REPORT.md (한국어)
   - 가정 / 시장 맥락 / 경쟁·대체 / 타겟 / 리스크 섹션 포함
   - 투자 권유 금지, 가정 명시
3) README.md — 실행 방법

제약:
- MY Agent 제품(ui/workspace, shell) 금지. 이 폴더만.
- heavy_coder / run_terminal 쓰지 마.
- 완료= 위 파일이 모두 있을 때만.

지금 생성 시작.`;

function httpJson(method, pathname, bodyObj) {
  const body = bodyObj == null ? null : JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: API_HOST,
        port: API_PORT,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
        timeout: 120_000,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            data = { raw };
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function streamChat(sessionId, message, onStatus) {
  const body = JSON.stringify({ message, model: 'auto', mode: 'web_dev', attachments: [] });
  const HARD_MS = Number(process.env.CQR_HEAVY_TIMEOUT_MS || 900_000);
  return new Promise((resolve, reject) => {
    const mutates = [];
    const statuses = [];
    let buffer = '';
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (err) reject(err);
      else resolve(val);
    };
    const hardTimer = setTimeout(() => {
      try {
        req.destroy(new Error(`hard timeout ${HARD_MS}ms`));
      } catch {
        /* ignore */
      }
      finish(null, { mutates, statuses, timedOut: true });
    }, HARD_MS);

    const req = http.request(
      {
        hostname: API_HOST,
        port: API_PORT,
        path: '/chat/stream',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-CQR-Session': sessionId,
        },
        timeout: 0,
      },
      (res) => {
        if (res.statusCode !== 200) {
          let raw = '';
          res.on('data', (c) => {
            raw += c;
          });
          res.on('end', () => finish(new Error(`HTTP ${res.statusCode} ${raw.slice(0, 400)}`)));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          // Prefer \n\n SSE framing; also flush on lone \n when event/data present.
          const parts = buffer.split(/\n\n/);
          buffer = parts.pop() || '';
          for (const block of parts) {
            const lines = block.split('\n');
            let event = 'message';
            let data = '';
            for (const line of lines) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              onStatus?.(`sse-raw ${event} ${data.slice(0, 160)}`);
              continue;
            }
            if (event === 'status' || parsed.type === 'status') {
              const msg = String(parsed.message || parsed.status || parsed.text || '');
              statuses.push(msg);
              onStatus?.(msg);
            } else if (parsed.type === 'workspace_mutate' || event === 'workspace_mutate') {
              const paths = parsed.paths || parsed.mutatedPaths || [];
              mutates.push(...paths);
              onStatus?.(`mutate ${paths.join(',')}`);
            } else if (event === 'token' || parsed.type === 'token') {
              /* noisy */
            } else {
              onStatus?.(`${event}/${parsed.type || '?'} ${JSON.stringify(parsed).slice(0, 140)}`);
            }
          }
        });
        res.on('end', () => finish(null, { mutates, statuses, timedOut: false }));
        res.on('error', (e) => finish(e));
      },
    );
    req.setTimeout(0);
    req.on('error', (e) => finish(e));
    req.write(body);
    req.end();
  });
}

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function scoreHeavy({ disk, mutates, statuses, syntaxOk, elapsedMs, market }) {
  const turn = statuses.find((s) => /Agent runtime/i.test(s)) || '';
  const agentOpen = /Agent runtime/i.test(turn);
  const askLock = /작업 모드 · ask/i.test(statuses.join('\n'));
  const mutateOk = mutates.length > 0;

  // Execution — harder than todo probe
  let cqr = 25;
  if (agentOpen) cqr += 15;
  if (!askLock) cqr += 10;
  if (mutateOk) cqr += 10;
  if (disk.appFiles) cqr += 10;
  if (disk.market) cqr += 15; // both planes in one turn
  if (disk.readme) cqr += 5;
  if (syntaxOk) cqr += 5;
  if (elapsedMs <= 180_000) cqr += 5;
  else if (elapsedMs > 600_000) cqr -= 10;
  // Penalty: missing either half
  if (disk.appFiles && !disk.market) cqr -= 20;
  if (!disk.appFiles && disk.market) cqr -= 20;

  // App quality
  let app = 20;
  if (disk.appFiles) app += 20;
  if (syntaxOk) app += 10;
  if (disk.localStorage) app += 10;
  if (disk.menuCards) app += 15;
  if (disk.quote) app += 15;
  if (disk.readme) app += 10;

  // Market report quality (no live crawl required — structure + honesty)
  let mkt = 15;
  if (disk.market) mkt += 15;
  if (market.bytes >= 1200) mkt += 10;
  if (market.hasAssumption) mkt += 15;
  if (market.hasCompetition) mkt += 15;
  if (market.hasTarget) mkt += 15;
  if (market.hasRisk) mkt += 10;
  if (market.noAdvice) mkt += 5;

  const overall = clamp(cqr * 0.4 + app * 0.3 + mkt * 0.3);
  return {
    cqr: clamp(cqr),
    app: clamp(app),
    market: clamp(mkt),
    overall,
    agentOpen,
    askLock,
    turn,
  };
}

async function main() {
  const t0 = Date.now();
  const logPath = path.join(outDir, `drive-${Date.now()}.log`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const say = (s) => {
    const line = `[${new Date().toISOString()}] ${s}`;
    console.log(line);
    log.write(`${line}\n`);
  };

  const health = await httpJson('GET', '/health');
  say(`health ${health.status}`);
  if (!health.ok) process.exit(1);

  mkdirSync(path.join(WORKSPACE, 'docs'), { recursive: true });
  const ws = await httpJson('PUT', '/config/dev-workspace', { dev_workspace_root: WORKSPACE });
  say(`workspace ${ws.status} ${ws.data?.dev_workspace_root || ''}`);

  const sess = await httpJson('POST', '/sessions', { title: 'heavy score: lunch sub + market' });
  const sessionId = sess.data?.id || sess.data?.session?.id;
  say(`session=${sessionId}`);
  say('POST /chat/stream (market+app) …');

  const { mutates, statuses, timedOut } = await streamChat(sessionId, MESSAGE, (s) => {
    if (/Agent runtime|작업 모드|write_file|edit_file|ASK|mutate|sse-raw|agent|Error|오류|완료|PARTIAL/i.test(s)) {
      say(`live: ${String(s).slice(0, 220)}`);
    }
  });
  if (timedOut) say('WARN: stream hard-timeout — scoring disk as-is');
  for (const s of statuses) {
    if (/Agent runtime|작업 모드|write_file|edit_file|ASK/i.test(s)) say(`status: ${s.slice(0, 220)}`);
  }
  const uniq = [...new Set(mutates)];
  say(`mutates=${uniq.join(',') || '(none)'}`);

  const read = (rel) => {
    const p = path.join(WORKSPACE, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };
  const appJs = read('app.js');
  const html = read('index.html');
  const marketMd = read('docs/MARKET_REPORT.md');
  const readme = read('README.md');
  const chk = spawnSync(process.execPath, ['--check', path.join(WORKSPACE, 'app.js')], {
    encoding: 'utf8',
  });
  const syntaxOk = existsSync(path.join(WORKSPACE, 'app.js')) && chk.status === 0;

  const disk = {
    index: existsSync(path.join(WORKSPACE, 'index.html')),
    styles: existsSync(path.join(WORKSPACE, 'styles.css')),
    app: existsSync(path.join(WORKSPACE, 'app.js')),
    market: existsSync(path.join(WORKSPACE, 'docs', 'MARKET_REPORT.md')),
    readme: existsSync(path.join(WORKSPACE, 'README.md')),
    appFiles:
      existsSync(path.join(WORKSPACE, 'index.html'))
      && existsSync(path.join(WORKSPACE, 'styles.css'))
      && existsSync(path.join(WORKSPACE, 'app.js')),
    localStorage: /localStorage/i.test(appJs),
    menuCards: (html.match(/card|menu|도시락|메뉴/gi) || []).length >= 3 || /menuItems|MENUS|menus\s*=/i.test(appJs),
    quote: /인원|단가|견적|total|qty|quantity|price/i.test(appJs + html),
  };

  const market = {
    bytes: marketMd.length,
    hasAssumption: /가정/i.test(marketMd),
    hasCompetition: /경쟁|대체/i.test(marketMd),
    hasTarget: /타겟|고객/i.test(marketMd),
    hasRisk: /리스크|위험|한계/i.test(marketMd),
    noAdvice: !/매수\s*추천|투자\s*하라|꼭\s*사라/i.test(marketMd),
  };

  const elapsedMs = Date.now() - t0;
  const scores = scoreHeavy({ disk, mutates: uniq, statuses, syntaxOk, elapsedMs, market });

  const report = {
    at: new Date().toISOString(),
    workspace: WORKSPACE,
    sessionId,
    elapsedMs,
    mutatePaths: uniq,
    disk,
    market,
    syntaxOk,
    scores,
    compare: {
      todoProbeAvg: 86,
      wpxozmAfterFix: { cqr: 65, app: 72 },
    },
    statusesHead: statuses.filter(Boolean).slice(0, 40),
    logPath,
  };

  writeFileSync(path.join(outDir, 'SCORECARD.json'), JSON.stringify(report, null, 2));
  writeFileSync(
    path.join(outDir, 'SCORECARD.md'),
    [
      '# MY Agent 헤비 실사용 점수 (시장조사 + 앱)',
      '',
      `| 항목 | 점수 |`,
      `|---|---|`,
      `| MY Agent 이행도 | **${scores.cqr}/100** |`,
      `| 앱 완성도 | **${scores.app}/100** |`,
      `| 시장보고서 | **${scores.market}/100** |`,
      `| **종합** | **${scores.overall}/100** |`,
      '',
      `비교: Todo 프로브 종합~86 · wpxozm 수정직후 ~68`,
      '',
      `- agent: ${scores.agentOpen} · ASK: ${scores.askLock}`,
      `- app files: ${disk.appFiles} · market: ${disk.market} · syntax: ${syntaxOk}`,
      `- elapsed: ${Math.round(elapsedMs / 1000)}s`,
      `- market bytes: ${market.bytes}`,
      '',
    ].join('\n'),
  );

  say(
    `SCORE overall=${scores.overall} cqr=${scores.cqr} app=${scores.app} market=${scores.market} elapsed=${Math.round(elapsedMs / 1000)}s`,
  );
  process.exit(disk.appFiles && disk.market && syntaxOk ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
