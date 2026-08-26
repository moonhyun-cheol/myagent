#!/usr/bin/env node
/**
 * Quick latency probe after stream-safe greenfield changes.
 * Expect: single coder (no planner), first write_file within ~90s, http500=0.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const API_HOST = '127.0.0.1';
const API_PORT = Number(process.env.MY_AGENT_API_PORT || 10200);
const WORKSPACE =
  process.env.CQR_EVAL_WORKSPACE
  || 'C:\\Users\\Temp\\Desktop\\현철\\코딩연습\\cqr_streamsafe_probe';

try {
  rmSync(WORKSPACE, { recursive: true, force: true });
} catch {
  /* ignore */
}
mkdirSync(WORKSPACE, { recursive: true });
const outDir = path.join(WORKSPACE, '_score_eval');
mkdirSync(outDir, { recursive: true });

const MESSAGE = `web_dev AGENT. 빈 폴더에 미니 랜딩 만들어. write_file만.
필수: index.html, styles.css, app.js, README.md
제약: 제품 소스 금지. heavy_coder/run_terminal 금지. 지금 시작.`;

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
        timeout: 60_000,
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

async function main() {
  const t0 = Date.now();
  const log = createWriteStream(path.join(outDir, 'drive.log'), { flags: 'a' });
  const say = (s) => {
    const line = `[${new Date().toISOString()}] ${s}`;
    console.log(line);
    log.write(`${line}\n`);
  };

  await httpJson('PUT', '/config/dev-workspace', { dev_workspace_root: WORKSPACE });
  const sess = await httpJson('POST', '/sessions', { title: 'streamsafe probe' });
  const sessionId = sess.data?.id || sess.data?.session?.id;
  say(`session=${sessionId}`);

  const body = JSON.stringify({ message: MESSAGE, model: 'auto', mode: 'web_dev', attachments: [] });
  let firstMutateMs = null;
  let turn = '';
  let http500 = 0;
  let terminated = 0;
  const mutates = [];

  await new Promise((resolve, reject) => {
    let buffer = '';
    const hard = setTimeout(() => {
      req.destroy();
      resolve();
    }, Number(process.env.CQR_PROBE_TIMEOUT_MS || 300_000));
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
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          const parts = buffer.split(/\n\n/);
          buffer = parts.pop() || '';
          for (const block of parts) {
            const lines = block.split('\n');
            let data = '';
            for (const line of lines) {
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            const text = String(parsed.text || parsed.message || '');
            if (parsed.type === 'status' && /Agent runtime/i.test(text)) {
              turn = text;
              say(`live: ${text}`);
            }
            if (/HTTP 500/i.test(text)) http500 += 1;
            if (/terminated|STREAM_TERMINATED/i.test(text)) terminated += 1;
            if (parsed.type === 'workspace_mutate') {
              const paths = parsed.paths || [];
              mutates.push(...paths);
              if (firstMutateMs == null) {
                firstMutateMs = Date.now() - t0;
                say(`first-mutate ${firstMutateMs}ms ${paths.join(',')}`);
              }
            }
            if (/실행 · write_file/i.test(text) && firstMutateMs == null) {
              firstMutateMs = Date.now() - t0;
              say(`first-write status ${firstMutateMs}ms ${text.slice(0, 120)}`);
            }
          }
        });
        res.on('end', () => {
          clearTimeout(hard);
          resolve();
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const files = ['index.html', 'styles.css', 'app.js', 'README.md'].filter((f) =>
    existsSync(path.join(WORKSPACE, f)),
  );
  const elapsed = Date.now() - t0;
  const noPlanner = /roles=coder|single_coder|agent\/files\/coder/i.test(turn) && !/planner/i.test(turn);
  const report = {
    elapsedMs: elapsed,
    firstMutateMs,
    turn,
    noPlanner,
    http500,
    terminated,
    files,
    mutatePaths: [...new Set(mutates)],
  };
  writeFileSync(path.join(outDir, 'RESULT.json'), JSON.stringify(report, null, 2));
  say(
    `RESULT files=${files.length}/4 firstMutateMs=${firstMutateMs} noPlanner=${noPlanner} http500=${http500} elapsed=${Math.round(elapsed / 1000)}s`,
  );
  process.exit(files.length >= 4 && firstMutateMs != null && firstMutateMs < 180_000 ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
