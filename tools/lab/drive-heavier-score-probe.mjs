#!/usr/bin/env node
/**
 * Heavier score probe (post Exit-Gate/500 fix):
 * market report + multi-file real-estate landing + data JSON in ONE web_dev turn.
 */
import { createWriteStream, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const API_HOST = '127.0.0.1';
const API_PORT = Number(process.env.MY_AGENT_API_PORT || 10200);
const WORKSPACE =
  process.env.CQR_EVAL_WORKSPACE || 'C:\\Users\\Temp\\Desktop\\현철\\코딩연습\\cqr_heavier_probe';
const outDir = path.join(WORKSPACE, '_score_eval');

if (process.env.CQR_HEAVY_CLEAN !== '0') {
  try {
    rmSync(WORKSPACE, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
mkdirSync(path.join(WORKSPACE, 'docs'), { recursive: true });
mkdirSync(path.join(WORKSPACE, 'data'), { recursive: true });
mkdirSync(outDir, { recursive: true });

const MESSAGE = `web_dev AGENT. 빈 워크스페이스에 「수도권 분양 상담 랜딩」을 한 번에 완성해. write_file/edit_file만.

필수 (디스크에 실제로 존재):
1) index.html + styles.css + app.js
   - 단지 카드 3개 이상 (data/units.json 로드)
   - 관심 상담 메모 입력 + localStorage 저장/복원
   - 간단 상담 일정(날짜+시간) 선택 UI
2) data/units.json — name/area/price/tag 필드 포함 단지 ≥3
3) contact.html — 문의 폼(이름·연락처·메모) + app-contact.js (localStorage)
4) docs/MARKET_REPORT.md (한국어)
   - 가정 / 시장 맥락 / 경쟁·대체 / 타겟 / 리스크 섹션
   - 투자 권유 금지, 가정 명시
5) README.md — 실행 방법

제약:
- MY Agent 제품(ui/workspace, shell) 금지. 이 폴더만.
- heavy_coder / run_terminal 쓰지 마.
- 완료= 위 파일이 모두 있을 때만. 지금 생성 시작.`;

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
    let http500 = 0;
    let exitGatePoison = 0;
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
      finish(null, { mutates, statuses, timedOut: true, http500, exitGatePoison });
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
              continue;
            }
            const text = String(parsed.message || parsed.status || parsed.text || '');
            if (event === 'status' || parsed.type === 'status') {
              statuses.push(text);
              if (/HTTP 500/i.test(text)) http500 += 1;
              if (/Exit Gate|중단 복구/i.test(text)) exitGatePoison += 1;
              onStatus?.(text);
            } else if (parsed.type === 'workspace_mutate' || event === 'workspace_mutate') {
              const paths = parsed.paths || parsed.mutatedPaths || [];
              mutates.push(...paths);
              onStatus?.(`mutate ${paths.join(',')}`);
            }
          }
        });
        res.on('end', () =>
          finish(null, { mutates, statuses, timedOut: false, http500, exitGatePoison }),
        );
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

function scoreHeavier({ disk, mutates, statuses, syntaxOk, unitsOk, elapsedMs, market, http500, exitGatePoison }) {
  const turn = statuses.find((s) => /Agent runtime/i.test(s)) || '';
  const agentOpen = /Agent runtime/i.test(turn);
  const askLock = /작업 모드 · ask/i.test(statuses.join('\n'));
  const mutateOk = mutates.length > 0 || disk.appFiles;

  let cqr = 20;
  if (agentOpen) cqr += 15;
  if (!askLock) cqr += 10;
  if (mutateOk) cqr += 10;
  if (disk.appFiles) cqr += 8;
  if (disk.market) cqr += 10;
  if (disk.units) cqr += 8;
  if (disk.contact) cqr += 8;
  if (disk.readme) cqr += 4;
  if (syntaxOk) cqr += 5;
  if (elapsedMs <= 240_000) cqr += 8;
  else if (elapsedMs <= 420_000) cqr += 3;
  else if (elapsedMs > 600_000) cqr -= 8;
  // Reliability (post-fix): thrash should be rare
  if (http500 === 0) cqr += 6;
  else cqr -= Math.min(18, http500 * 4);
  if (exitGatePoison === 0) cqr += 4;
  else cqr -= Math.min(12, exitGatePoison * 3);
  if (disk.appFiles && !disk.market) cqr -= 15;
  if (!disk.appFiles && disk.market) cqr -= 15;

  let app = 15;
  if (disk.appFiles) app += 15;
  if (syntaxOk) app += 8;
  if (disk.localStorage) app += 10;
  if (disk.menuCards) app += 10;
  if (disk.schedule) app += 10;
  if (disk.units && unitsOk) app += 12;
  if (disk.contact) app += 12;
  if (disk.readme) app += 8;

  let mkt = 15;
  if (disk.market) mkt += 15;
  if (market.bytes >= 1200) mkt += 10;
  if (market.hasAssumption) mkt += 15;
  if (market.hasCompetition) mkt += 15;
  if (market.hasTarget) mkt += 15;
  if (market.hasRisk) mkt += 10;
  if (market.noAdvice) mkt += 5;

  return {
    cqr: clamp(cqr),
    app: clamp(app),
    market: clamp(mkt),
    overall: clamp(cqr * 0.4 + app * 0.3 + mkt * 0.3),
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

  const ws = await httpJson('PUT', '/config/dev-workspace', { dev_workspace_root: WORKSPACE });
  say(`workspace ${ws.status} ${ws.data?.dev_workspace_root || ''}`);

  const sess = await httpJson('POST', '/sessions', { title: 'heavier: 분양 랜딩 + market' });
  const sessionId = sess.data?.id || sess.data?.session?.id;
  say(`session=${sessionId}`);
  say('POST /chat/stream (heavier market+app) …');

  const { mutates, statuses, timedOut, http500, exitGatePoison } = await streamChat(
    sessionId,
    MESSAGE,
    (s) => {
      if (
        /Agent runtime|작업 모드|write_file|edit_file|ASK|mutate|Exit Gate|HTTP 500|자동 이어|인프라/i.test(
          s,
        )
      ) {
        say(`live: ${String(s).slice(0, 220)}`);
      }
    },
  );
  if (timedOut) say('WARN: stream hard-timeout — scoring disk as-is');
  say(`reliability http500=${http500} exitGateMentions=${exitGatePoison}`);

  const uniq = [...new Set(mutates)];
  say(`mutates=${uniq.join(',') || '(none)'}`);

  const read = (rel) => {
    const p = path.join(WORKSPACE, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };
  const appJs = read('app.js');
  const html = read('index.html');
  const contactHtml = read('contact.html');
  const contactJs = read('app-contact.js');
  const marketMd = read('docs/MARKET_REPORT.md');
  const unitsRaw = read('data/units.json');
  let unitsOk = false;
  try {
    const u = JSON.parse(unitsRaw || '[]');
    const arr = Array.isArray(u) ? u : u.units || u.items || [];
    unitsOk =
      Array.isArray(arr)
      && arr.length >= 3
      && arr.every((x) => x && (x.name || x.title) && (x.price || x.area || x.tag));
  } catch {
    unitsOk = false;
  }

  const chkApp = spawnSync(process.execPath, ['--check', path.join(WORKSPACE, 'app.js')], {
    encoding: 'utf8',
  });
  const chkContact = existsSync(path.join(WORKSPACE, 'app-contact.js'))
    ? spawnSync(process.execPath, ['--check', path.join(WORKSPACE, 'app-contact.js')], {
        encoding: 'utf8',
      })
    : { status: 1 };
  const syntaxOk =
    existsSync(path.join(WORKSPACE, 'app.js'))
    && chkApp.status === 0
    && (!existsSync(path.join(WORKSPACE, 'app-contact.js')) || chkContact.status === 0);

  const disk = {
    index: existsSync(path.join(WORKSPACE, 'index.html')),
    styles: existsSync(path.join(WORKSPACE, 'styles.css')),
    app: existsSync(path.join(WORKSPACE, 'app.js')),
    units: existsSync(path.join(WORKSPACE, 'data', 'units.json')),
    contact:
      existsSync(path.join(WORKSPACE, 'contact.html'))
      && existsSync(path.join(WORKSPACE, 'app-contact.js')),
    market: existsSync(path.join(WORKSPACE, 'docs', 'MARKET_REPORT.md')),
    readme: existsSync(path.join(WORKSPACE, 'README.md')),
    appFiles:
      existsSync(path.join(WORKSPACE, 'index.html'))
      && existsSync(path.join(WORKSPACE, 'styles.css'))
      && existsSync(path.join(WORKSPACE, 'app.js')),
    localStorage: /localStorage/i.test(appJs + contactJs),
    menuCards:
      (html.match(/card|단지|분양|unit/gi) || []).length >= 3
      || /units\.json|fetch\(|units/i.test(appJs),
    schedule: /date|time|일정|상담|datetime|schedule/i.test(appJs + html),
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
  const scores = scoreHeavier({
    disk,
    mutates: uniq,
    statuses,
    syntaxOk,
    unitsOk,
    elapsedMs,
    market,
    http500,
    exitGatePoison,
  });

  const report = {
    at: new Date().toISOString(),
    workspace: WORKSPACE,
    sessionId,
    elapsedMs,
    mutatePaths: uniq,
    reliability: { http500, exitGatePoison, timedOut: !!timedOut },
    disk,
    unitsOk,
    market,
    syntaxOk,
    scores,
    compare: {
      todoProbeAvg: 86,
      priorHeavyOverall: 81,
      thisHeavierOverall: scores.overall,
    },
    statusesHead: statuses.filter(Boolean).slice(0, 50),
    logPath,
  };

  writeFileSync(path.join(outDir, 'SCORECARD.json'), JSON.stringify(report, null, 2));
  writeFileSync(
    path.join(outDir, 'SCORECARD.md'),
    [
      '# MY Agent 헤비어 실사용 점수 (분양 랜딩 + 시장 + data/contact)',
      '',
      `| 항목 | 점수 |`,
      `|---|---|`,
      `| MY Agent 이행도 | **${scores.cqr}/100** |`,
      `| 앱 완성도 | **${scores.app}/100** |`,
      `| 시장보고서 | **${scores.market}/100** |`,
      `| **종합** | **${scores.overall}/100** |`,
      '',
      `비교: Todo~86 · prior heavy~81 · this **${scores.overall}**`,
      '',
      `- agent: ${scores.agentOpen} · ASK: ${scores.askLock}`,
      `- app/units/contact/market/syntax: ${disk.appFiles}/${disk.units}/${disk.contact}/${disk.market}/${syntaxOk}`,
      `- http500=${http500} exitGateMentions=${exitGatePoison}`,
      `- elapsed: ${Math.round(elapsedMs / 1000)}s · market bytes: ${market.bytes}`,
      '',
    ].join('\n'),
  );

  say(
    `SCORE overall=${scores.overall} cqr=${scores.cqr} app=${scores.app} market=${scores.market} elapsed=${Math.round(elapsedMs / 1000)}s http500=${http500}`,
  );
  const ok =
    disk.appFiles && disk.market && disk.units && disk.contact && syntaxOk && unitsOk && !timedOut;
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
