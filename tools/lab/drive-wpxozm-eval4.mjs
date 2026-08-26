#!/usr/bin/env node
/** Follow-up: create missing web app files only (docs already on disk). */
import { createWriteStream, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const API = process.env.MY_AGENT_API || 'http://127.0.0.1:10200';
const WORKSPACE = process.env.CQR_EVAL_WORKSPACE || String.raw`C:\Users\Temp\Desktop\현철\코딩연습\wpxozm`;
const outDir = path.join(WORKSPACE, '_my_agent_eval');
mkdirSync(outDir, { recursive: true });

const MESSAGE = `진행. Exit Gate: index.html + styles.css + app.js 를 이 워크스페이스 루트에 write_file로 지금 생성해.

중요:
- do-not-touch는 MY Agent 제품(ui/workspace, shell)뿐. index.html/styles.css/app.js 는 생성 대상(금지 아님).
- docs/README는 이미 있음. 웹앱 3파일만 만들면 됨.
- 재테크 포트폴리오 + 부동산 메모 + 마크다운 미리보기/다운로드 + localStorage.
- 터미널 실행·승인 대기 없이 write_file만 실행.`;

async function jfetch(pathname, opts = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  const logPath = path.join(outDir, `drive4-${Date.now()}.log`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const say = (s) => {
    const line = `[${new Date().toISOString()}] ${s}`;
    console.log(line);
    log.write(`${line}\n`);
  };

  await jfetch('/config/dev-workspace', {
    method: 'PUT',
    body: JSON.stringify({ dev_workspace_root: WORKSPACE }),
  });
  const sess = await jfetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'wpxozm drive4 webapp only' }),
  });
  const sessionId = sess.data?.id || sess.data?.session?.id;
  say(`session=${sessionId}`);

  const res = await fetch(`${API}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CQR-Session': sessionId,
    },
    body: JSON.stringify({ message: MESSAGE, model: 'auto', mode: 'web_dev', attachments: [] }),
  });
  say(`HTTP ${res.status}`);
  if (!res.ok || !res.body) {
    say(await res.text());
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistant = '';
  const mutates = [];
  let done = null;

  while (true) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    buffer += decoder.decode(value, { stream: true });
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
        say(`status: ${parsed.message || parsed.status || parsed.text || JSON.stringify(parsed).slice(0, 180)}`);
      }
      if (parsed.type === 'workspace_mutate' || event === 'workspace_mutate') {
        const paths = parsed.paths || parsed.mutatedPaths || [];
        mutates.push(...paths);
        say(`mutate: ${paths.join(', ')}`);
      }
      if (parsed.delta) assistant += parsed.delta;
      if (typeof parsed.content === 'string' && parsed.type === 'answer') assistant = parsed.content;
      if (parsed.type === 'done' || event === 'done') {
        done = parsed;
        say(`done`);
      }
    }
  }

  const disk = {
    index: existsSync(path.join(WORKSPACE, 'index.html')),
    app: existsSync(path.join(WORKSPACE, 'app.js')),
    styles: existsSync(path.join(WORKSPACE, 'styles.css')),
    readme: existsSync(path.join(WORKSPACE, 'README.md')),
    market: existsSync(path.join(WORKSPACE, 'docs', 'MARKET_REPORT.md')),
    acceptance: existsSync(path.join(WORKSPACE, 'docs', 'ACCEPTANCE.md')),
  };
  const summary = {
    at: new Date().toISOString(),
    sessionId,
    mutatePaths: [...new Set(mutates)],
    disk,
    done,
    logPath,
    assistantTail: assistant.slice(-600),
  };
  writeFileSync(path.join(outDir, 'drive4-summary.json'), JSON.stringify(summary, null, 2));
  say(`disk=${JSON.stringify(disk)} mutates=${summary.mutatePaths.join(',')}`);
  process.exit(disk.index && disk.app && disk.styles ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
