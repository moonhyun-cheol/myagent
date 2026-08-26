#!/usr/bin/env node
/**
 * Real-use coding smoke: mutate existing wpxozm app via MY Agent web_dev.
 * Uses node:http (no body timeout) for long agent streams.
 */
import { createWriteStream, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const API_HOST = '127.0.0.1';
const API_PORT = Number(process.env.MY_AGENT_API_PORT || 10200);
const WORKSPACE = process.env.CQR_EVAL_WORKSPACE || 'C:\\Users\\Temp\\Desktop\\현철\\코딩연습\\wpxozm';
const outDir = path.join(WORKSPACE, '_my_agent_eval');
mkdirSync(outDir, { recursive: true });

const beforeApp = existsSync(path.join(WORKSPACE, 'app.js'))
  ? readFileSync(path.join(WORKSPACE, 'app.js'), 'utf8')
  : '';

const MESSAGE = `web_dev AGENT. 바인딩된 이 폴더의 기존 앱을 수정해. edit_file/write_file만 사용.

Exit Gate:
- app.js에서 마크다운 미리보기/다운로드 본문 맨 위에 「생성 시각」 한 줄을 넣어.
  예: ## 생성 시각\\n- (new Date()).toLocaleString('ko-KR')
- MY Agent 제품(ui/workspace, shell) 건드리지 마. 루트 app.js만.
- heavy_coder / run_terminal 쓰지 마.
지금 edit_file 실행.`;

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
    let settled = false;

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
              statuses.push(parsed.message || parsed.status || parsed.text || parsed);
            }
            if (parsed.type === 'workspace_mutate' || event === 'workspace_mutate') {
              const paths = parsed.paths || parsed.mutatedPaths || [];
              mutates.push(...paths);
            }
            if (parsed.type === 'done' || event === 'done') {
              /* keep draining until socket end */
            }
          }
        });
        res.on('end', () => {
          if (!settled) {
            settled = true;
            resolve({ mutates, statuses });
          }
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(0);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const logPath = path.join(outDir, `realuse-${Date.now()}.log`);
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

  const sess = await httpJson('POST', '/sessions', { title: 'wpxozm realuse feature' });
  const sessionId = sess.data?.id || sess.data?.session?.id;
  say(`session=${sessionId}`);

  say('POST /chat/stream …');
  const { mutates, statuses } = await streamChat(sessionId, MESSAGE);
  for (const s of statuses) {
    if (/Agent runtime|mutate|write_file|edit_file|ASK|작업 모드|ERROR/i.test(String(s))) {
      say(`status: ${typeof s === 'string' ? s : JSON.stringify(s).slice(0, 220)}`);
    }
  }
  for (const p of mutates) say(`mutate: ${p}`);
  say('done');

  const afterApp = existsSync(path.join(WORKSPACE, 'app.js'))
    ? readFileSync(path.join(WORKSPACE, 'app.js'), 'utf8')
    : '';
  const changed = afterApp !== beforeApp;
  const hasTimestampFeature =
    /생성\s*시각|generatedAt|generated_at|toLocaleString|toISOString/i.test(afterApp);

  const summary = {
    at: new Date().toISOString(),
    sessionId,
    mutatePaths: [...new Set(mutates)],
    statusesHead: statuses.slice(0, 40).map((s) => (typeof s === 'string' ? s : JSON.stringify(s)).slice(0, 200)),
    disk: {
      appChanged: changed,
      hasTimestampFeature,
      appBytes: afterApp.length,
      root: WORKSPACE,
    },
    logPath,
  };
  writeFileSync(path.join(outDir, 'realuse-summary.json'), JSON.stringify(summary, null, 2));
  say(
    `RESULT changed=${changed} timestampFeature=${hasTimestampFeature} mutates=${summary.mutatePaths.join(',') || '(none)'}`,
  );
  process.exit(changed && hasTimestampFeature ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
