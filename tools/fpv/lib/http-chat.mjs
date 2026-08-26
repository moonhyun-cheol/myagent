#!/usr/bin/env node
/** Shared chat/session helpers for FPV journeys. Single x-cqr-session header only. */
import { withInfraRetry, waitForApi, sleep } from '../../lab/lab-live-http.mjs';

export { waitForApi, sleep, withInfraRetry };

export async function createSession(base) {
  const r = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`sessions ${r.status}`);
  const j = await r.json();
  const id = j?.id || j?.sessionId || j?.session?.id;
  if (!id) throw new Error('no session id');
  return String(id);
}

async function approve(base, id) {
  await fetch(`${base}/chat/tool-approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, approved: true }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
}

export async function streamChat(base, sessionId, message, mode, timeoutMs = 420_000, attachments = []) {
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      // Node fetch drops duplicate case-insensitive headers — one key only.
      'x-cqr-session': sessionId,
    },
    body: JSON.stringify({
      message,
      mode: mode || 'chat',
      attachments: Array.isArray(attachments) ? attachments : [],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    return {
      content: '',
      approvals: 0,
      ms: Date.now() - t0,
      error: `http ${res.status} ${text.slice(0, 200)}`,
    };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let approvals = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const block of parts) {
      const line = block
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === 'tool_approval' && ev.id) {
          approvals += 1;
          await approve(base, String(ev.id));
        }
        if (ev.type === 'content_replace' && (ev.text || ev.content)) {
          content = String(ev.text || ev.content);
        }
        if (ev.type === 'token' && ev.text) content += String(ev.text);
        if (ev.type === 'done' && (ev.content || ev.text)) {
          content = String(ev.content || ev.text);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { content, approvals, ms: Date.now() - t0 };
}

/** Upload a local file via multipart POST /attachments (plan: attach before chat). */
export async function uploadAttachment(base, sessionId, filePath, filename) {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const buf = readFileSync(filePath);
  const name = filename || path.basename(filePath);
  const boundary = `----FpvBoundary${Date.now()}`;
  const head = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${name}"`,
    'Content-Type: application/octet-stream',
    '',
    '',
  ].join('\r\n');
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), buf, Buffer.from(tail, 'utf8')]);
  const res = await fetch(`${base}/attachments`, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-cqr-session': sessionId,
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw Object.assign(new Error(`attach upload ${res.status}: ${t.slice(0, 200)}`), {
      tag: 'env-red',
    });
  }
  const j = await res.json();
  const id = j?.attachments?.[0]?.id || j?.id;
  if (!id) throw new Error('attach upload: no id');
  return String(id);
}

export async function healthOk(base) {
  try {
    const j = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }).then((r) =>
      r.json(),
    );
    return Boolean(j?.ok);
  } catch {
    return false;
  }
}
