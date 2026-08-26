#!/usr/bin/env node
// Does the OWUI image model actually return image payloads, and does an explicit
// image instruction change the hit rate vs. the bare user prompt?
// Usage: node tools/probe-owui-image.mjs [providerId] [modelId]
import path from 'node:path';
import { ProviderStore } from '../core/dist/providers/provider-store.js';

const cqrRoot = path.resolve(import.meta.dirname, '..');
const store = new ProviderStore(
  path.join(cqrRoot, 'data', 'vault', 'provider-keys.json'),
  cqrRoot,
);
const providerId = process.argv[2] || 'custom';
const resolved = store.resolveProvider(providerId);
if (!resolved) {
  console.error(`provider not configured: ${providerId}`);
  process.exit(1);
}
const model =
  process.argv[3] || 'open_webui_openrouter_integration.google.gemini-3-pro-image';
const url = `${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`;
console.log(`gateway: ${new URL(url).host}${new URL(url).pathname}`);
console.log(`model  : ${model}\n`);

async function probe(name, messages, extra = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.secret.api_key}`,
      },
      body: JSON.stringify({ model, messages, ...extra }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    const sec = Math.round((Date.now() - t0) / 1000);
    let content = '';
    try {
      content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
    } catch {
      content = text;
    }
    const hasDataUrl = /data:image\/[a-z]+;base64,/i.test(content);
    const fileIds = content.match(/\/api\/v1\/files\/[\w-]+/gi) ?? [];
    const verdict = hasDataUrl || fileIds.length ? 'IMAGE' : 'TEXT-ONLY';
    console.log(
      `${name} -> HTTP ${res.status} ${sec}s ${verdict} (dataUrl=${hasDataUrl} fileRefs=${fileIds.length} len=${content.length})`,
    );
    console.log(`   head: ${content.slice(0, 140).replace(/\s+/g, ' ')}\n`);
    return verdict === 'IMAGE';
  } catch (e) {
    console.log(`${name} -> THROW ${e.name} ${String(e.message).slice(0, 120)}\n`);
    return false;
  }
}

// Exactly what CloudChatService.buildMessages() sends today.
const chatSystem = [
  '기본적으로 한국어로 답변하세요.',
  '사용자가 영어로만 질문한 경우에만 영어로 답할 수 있습니다.',
  '사용자가 한국어로 질문했는데 중국어(简体/繁體) 설명·리뷰·제안을 쓰지 마세요.',
  '코드 식별자·원문 주석·도메인 글자(예: 麻雀 패 이름 萬筒索)는 파일 그대로 두고, 해설은 한국어로 하세요.',
].join(' ');

const ask = [{ role: 'user', content: '고양이 로고' }];
const bare = await probe('1 bare                ', ask);
const withChatSystem = await probe('2 + chat systemPrompt ', [
  { role: 'system', content: chatSystem },
  ...ask,
]);

console.log(
  `summary: bare=${bare ? 'IMAGE' : 'TEXT'} chatSystemPrompt=${withChatSystem ? 'IMAGE' : 'TEXT'}`,
);
