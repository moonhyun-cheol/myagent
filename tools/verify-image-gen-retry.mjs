#!/usr/bin/env node
// Golden: chat-based image models sometimes answer a terse prompt with prose instead of
// drawing. image_gen must retry once with an explicit draw directive, and must not report
// a config problem when the model simply replied with text.
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const { handleImageGenMode } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'chat', 'modes', 'image-gen.js')).href
);

// 1x1 transparent PNG — ingestOwuiChatImages writes data URLs locally, no network.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

const TEXT_REPLY = '## 고양이 로고 아이디어\n\n어떤 스타일의 로고를 원하시는지 구체적인 정보가 없어서…';

function makeDeps(replies) {
  const calls = [];
  // assertWritablePath only allows paths under cqrRoot, so stage inside the repo.
  const scratch = path.join(root, 'data', 'outputs', 'verify-image-gen');
  mkdirSync(scratch, { recursive: true });
  const imageOut = mkdtempSync(path.join(scratch, 'run-'));
  return {
    imageOut,
    calls,
    deps: {
      attachments: { get: () => null },
      cloudChat: {
        complete: async (providerId, message, attachmentContext, history, systemPrompt) => {
          calls.push({ message, systemPrompt: systemPrompt ?? null });
          const content = replies[Math.min(calls.length - 1, replies.length - 1)];
          return { content, model: 'owui/gemini-3-pro-image' };
        },
      },
      imageBackend: {
        generate: async () => {
          throw new Error('local backend must not be used on the OWUI custom path');
        },
      },
      providerStore: {
        getDefinition: () => ({ custom: true, name: 'owui' }),
        resolveProvider: () => ({
          secret: { api_key: 'live-key' },
          baseUrl: 'https://example.invalid/api',
          def: { name: 'owui' },
          modelId: 'gemini-3-pro-image',
        }),
      },
      sessionStore: { append: () => {} },
      cqrRoot: root,
      imageOut,
      sessionId: 'imggen-retry-test',
      message: '고양이 로고',
      routing: { mode: 'image_gen', confidence: 1, layer: 'explicit' },
      resolved: {
        display: 'gemini-3-pro-image (이미지·영상 생성)',
        route: { type: 'provider', providerId: 'custom', modelId: 'gemini-3-pro-image' },
      },
      attachmentIds: [],
    },
  };
}

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  OK   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// Case 1: text first, image on the retry.
{
  const { deps, calls, imageOut } = makeDeps([TEXT_REPLY, `![img](${PNG_DATA_URL})`]);
  const res = await handleImageGenMode(deps);
  check('text-then-image retries once', calls.length === 2, `calls=${calls.length}`);
  check(
    'retry carries the explicit draw directive',
    calls.length === 2 && /Generate the image now/i.test(calls[1].systemPrompt ?? ''),
    `systemPrompt=${calls[1]?.systemPrompt}`,
  );
  check('first attempt sends no directive', calls[0]?.systemPrompt === null);
  check('retry image is returned', Boolean(res.image?.url), JSON.stringify(res.image ?? null));
  rmSync(imageOut, { recursive: true, force: true });
}

// Case 2: image on the first attempt — no wasted retry.
{
  const { deps, calls, imageOut } = makeDeps([`![img](${PNG_DATA_URL})`]);
  const res = await handleImageGenMode(deps);
  check('image on first attempt does not retry', calls.length === 1, `calls=${calls.length}`);
  check('first-attempt image is returned', Boolean(res.image?.url));
  rmSync(imageOut, { recursive: true, force: true });
}

// Case 3: text both times — report the model reply, not a config checklist.
{
  const { deps, calls, imageOut } = makeDeps([TEXT_REPLY, TEXT_REPLY]);
  const res = await handleImageGenMode(deps);
  check('text twice stops after the retry', calls.length === 2, `calls=${calls.length}`);
  check('no image is claimed', !res.image);
  check(
    'failure names the text reply',
    /이미지 대신 텍스트/.test(res.content),
    res.content.slice(0, 160),
  );
  check(
    'failure quotes the model reply',
    res.content.includes('모델 응답:'),
    res.content.slice(0, 160),
  );
  check(
    'failure does not blame API key config',
    !res.content.includes('Open WebUI API Key'),
    res.content.slice(0, 200),
  );
  rmSync(imageOut, { recursive: true, force: true });
}

rmSync(path.join(root, 'data', 'outputs', 'verify-image-gen'), { recursive: true, force: true });

if (failed > 0) {
  console.error(`verify-image-gen-retry FAILED (${failed})`);
  process.exit(1);
}
console.log('verify-image-gen-retry OK');
