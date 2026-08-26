#!/usr/bin/env node
/**
 * Score probe: greenfield app via MY Agent → disk evidence → scorecard.
 */
import { createWriteStream, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const API_HOST = '127.0.0.1';
const API_PORT = Number(process.env.MY_AGENT_API_PORT || 10200);
const WORKSPACE =
  process.env.CQR_EVAL_WORKSPACE || 'C:\\Users\\Temp\\Desktop\\현철\\코딩연습\\cqr_score_probe';
const outDir = path.join(WORKSPACE, '_score_eval');
mkdirSync(outDir, { recursive: true });

const MESSAGE = `web_dev AGENT. 빈 폴더에 「미니 할일(Todo)」 웹앱을 지금 만들어. edit_file/write_file만.

필수 산출물 (이 워크스페이스 루트):
1) index.html — 할일 입력, 목록, 완료 토글, 삭제
2) styles.css — 읽기 쉬운 레이아웃
3) app.js — localStorage 저장/복원
4) README.md — 실행 방법 3줄 이내

제약:
- MY Agent 제품(ui/workspace, shell) 건드리지 마. 이 폴더만.
- heavy_coder / run_terminal 쓰지 마.
- 완료= 위 4파일이 디스크에 있을 때만.

지금 write_file로 생성 시작.`;

function httpJson(method, pathname, bodyObj, headers = {}) {
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
          ...headers,
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

function streamChat(sessionId, message) {
  const body = JSON.stringify({ message, model: 'auto', mode: 'web_dev', attachments: [] });
  return new Promise((resolve, reject) => {
    const mutates = [];
    const statuses = [];
    let buffer = '';
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
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode} ${raw.slice(0, 400)}`)));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          const parts = buffer.split('\n\n');
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
            if (event === 'status' || parsed.type === 'status') {
              statuses.push(String(parsed.message || parsed.status || parsed.text || ''));
            }
            if (parsed.type === 'workspace_mutate' || event === 'workspace_mutate') {
              mutates.push(...(parsed.paths || parsed.mutatedPaths || []));
            }
          }
        });
        res.on('end', () => resolve({ mutates, statuses }));
        res.on('error', reject);
      },
    );
    req.setTimeout(0);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function scorecard({ disk, mutates, statuses, syntaxOk, elapsedMs }) {
  const turn = statuses.find((s) => /Agent runtime/i.test(s)) || '';
  const agentOpen = /Agent runtime/i.test(turn);
  const askLock = /작업 모드 · ask/i.test(statuses.join('\n'));
  const filesOk = disk.index && disk.app && disk.styles && disk.readme;
  const mutateHit = mutates.some((p) => /index\.html|app\.js|styles\.css|README/i.test(p));

  // MY Agent execution score (path reliability)
  let cqr = 40;
  if (agentOpen) cqr += 20;
  if (!askLock) cqr += 10;
  if (mutateHit) cqr += 15;
  if (filesOk) cqr += 10;
  if (syntaxOk) cqr += 5;
  if (elapsedMs < 180_000) cqr += 0;
  else if (elapsedMs > 600_000) cqr -= 5;
  cqr = Math.max(0, Math.min(100, cqr));

  // Deliverable quality (mini todo SPA)
  let app = 30;
  if (filesOk) app += 25;
  if (syntaxOk) app += 10;
  if (disk.appBytes >= 400 && disk.appBytes <= 40_000) app += 10;
  if (disk.hasLocalStorage) app += 10;
  if (disk.hasToggleOrComplete) app += 10;
  if (disk.readmeOk) app += 5;
  app = Math.max(0, Math.min(100, app));

  return { cqr, app, turn, agentOpen, askLock, filesOk, mutateHit };
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

  const sess = await httpJson('POST', '/sessions', { title: 'score probe todo' });
  const sessionId = sess.data?.id || sess.data?.session?.id;
  say(`session=${sessionId}`);
  say('POST /chat/stream …');

  const { mutates, statuses } = await streamChat(sessionId, MESSAGE);
  for (const s of statuses) {
    if (/Agent runtime|작업 모드|write_file|edit_file|ASK|mutate/i.test(s)) say(`status: ${s.slice(0, 220)}`);
  }
  say(`mutates=${[...new Set(mutates)].join(',') || '(none)'}`);

  const read = (f) => {
    const p = path.join(WORKSPACE, f);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };
  const appJs = read('app.js');
  const readme = read('README.md');
  const chk = spawnSync(process.execPath, ['--check', path.join(WORKSPACE, 'app.js')], {
    encoding: 'utf8',
  });
  const syntaxOk = existsSync(path.join(WORKSPACE, 'app.js')) && chk.status === 0;

  const disk = {
    index: existsSync(path.join(WORKSPACE, 'index.html')),
    styles: existsSync(path.join(WORKSPACE, 'styles.css')),
    app: existsSync(path.join(WORKSPACE, 'app.js')),
    readme: existsSync(path.join(WORKSPACE, 'README.md')),
    appBytes: appJs.length,
    hasLocalStorage: /localStorage/i.test(appJs),
    hasToggleOrComplete: /complet|toggle|done|체크|완료/i.test(appJs + read('index.html')),
    readmeOk: /실행|open|브라우저|index\.html/i.test(readme),
  };

  const elapsedMs = Date.now() - t0;
  const scores = scorecard({
    disk,
    mutates: [...new Set(mutates)],
    statuses,
    syntaxOk,
    elapsedMs,
  });

  const report = {
    at: new Date().toISOString(),
    workspace: WORKSPACE,
    sessionId,
    elapsedMs,
    mutatePaths: [...new Set(mutates)],
    disk,
    syntaxOk,
    scores,
    priorReference: {
      note: '이전 wpxozm 평가(수정 후): 앱~72 / MY Agent~65. 사용자 기억 81은 별도 수치일 수 있음.',
      priorApp: 72,
      priorCqr: 65,
    },
    statusesHead: statuses.filter(Boolean).slice(0, 35),
    logPath,
  };
  writeFileSync(path.join(outDir, 'SCORECARD.json'), JSON.stringify(report, null, 2));
  writeFileSync(
    path.join(outDir, 'SCORECARD.md'),
    [
      '# MY Agent 실사용 점수 (cqr_score_probe)',
      '',
      `| 항목 | 점수 |`,
      `|---|---|`,
      `| **MY Agent 이행도** | **${scores.cqr}/100** |`,
      `| **산출물 완성도** | **${scores.app}/100** |`,
      `| 종합 (평균) | **${Math.round((scores.cqr + scores.app) / 2)}/100** |`,
      '',
      `이전(wpxozm 수정 후): CQR~65 / 앱~72`,
      '',
      `- Agent runtime: ${scores.agentOpen}`,
      `- ASK lock: ${scores.askLock}`,
      `- files on disk: ${scores.filesOk}`,
      `- syntax: ${syntaxOk}`,
      `- elapsed: ${Math.round(elapsedMs / 1000)}s`,
      '',
    ].join('\n'),
    'utf8',
  );

  say(
    `SCORE cqr=${scores.cqr} app=${scores.app} avg=${Math.round((scores.cqr + scores.app) / 2)} files=${JSON.stringify(disk)}`,
  );
  process.exit(scores.filesOk && syntaxOk ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
