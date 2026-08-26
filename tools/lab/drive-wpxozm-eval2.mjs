#!/usr/bin/env node
/** Retry mutate-primary drive (avoid ASK lock from 검증/평가 wording). */
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.MY_AGENT_API || 'http://127.0.0.1:10200';
const WORKSPACE = process.env.CQR_EVAL_WORKSPACE || String.raw`C:\Users\Temp\Desktop\현철\코딩연습\wpxozm`;
const outDir = path.join(WORKSPACE, '_my_agent_eval');
mkdirSync(outDir, { recursive: true });

const MESSAGE = `web_dev AGENT로 이 워크스페이스에 프로그램을 만들어줘. 수정·작성 실행.

만들어 줄 것:
1. index.html, styles.css, app.js — 재테크·부동산 보고서 웹앱 (포트폴리오 요약, 부동산 메모, 마크다운 보고서 미리보기, localStorage)
2. docs/MARKET_REPORT.md — 한국어 시장·경쟁·타겟 분석
3. docs/ACCEPTANCE.md — 생성 파일 목록과 실행 방법
4. README.md

규칙: MY Agent 제품 코드는 건드리지 마. 이 폴더만 내장 write_file/edit_file/apply_patch로 수정. 지금 파일 생성 시작해.`;

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
  const logPath = path.join(outDir, `drive2-${Date.now()}.log`);
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
    body: JSON.stringify({}),
  });
  const sessionId = sess.data?.id;
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
  const statuses = [];
  let modeHint = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const block of parts) {
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (evt.type === 'status' && evt.text) {
        statuses.push(evt.text);
        if (/작업 모드|ASK|AGENT|PLAN|mutate|write_file|실행 ·/i.test(evt.text)) say(evt.text);
        if (/작업 모드/.test(evt.text)) modeHint = evt.text;
      } else if (evt.type === 'token' && evt.text) assistant += evt.text;
      else if (evt.type === 'content_replace' && evt.text) assistant = evt.text;
      else if (evt.type === 'workspace_mutate') {
        const paths = Array.isArray(evt.paths) ? evt.paths : [];
        mutates.push(...paths);
        say(`mutate: ${paths.join(', ')}`);
      } else if (evt.type === 'done' || evt.type === 'error') {
        say(`${evt.type}`);
      }
    }
  }

  const summary = {
    at: new Date().toISOString(),
    sessionId,
    modeHint,
    mutatePaths: [...new Set(mutates)],
    statusSample: statuses.filter((s) => /작업 모드|ASK|AGENT|write_file|실행 ·|mutate/i.test(s)),
    assistantTail: assistant.slice(-2500),
    assistantChars: assistant.length,
  };
  writeFileSync(path.join(outDir, 'drive2-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'assistant2-final.md'), assistant || '(empty)');
  say(`mutates=${summary.mutatePaths.length} modeHint=${modeHint}`);
  log.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
