import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AttachmentService } from '../../attachments/attachment-service.js';
import type { AutoImageBackend } from '../../image/image-backend.js';
import type { CloudChatService } from '../../providers/cloud-chat.js';
import type { ProviderStore } from '../../providers/provider-store.js';
import type { SessionStore } from '../../sessions/session-store.js';
import type { ChatResponse, RouteDecision } from '../../router/types.js';
import type { ResolvedModelRoute } from '../../providers/types.js';
import { ingestOwuiChatImages } from '../../image/owui-media.js';
import { assertWritablePath } from '../../security/path-guard.js';
import { appendAssistantReply } from '../assistant-reply.js';

function resolveInitImage(
  attachments: AttachmentService,
  attachmentIds: string[],
  sessionId: string,
): string | undefined {
  for (const id of attachmentIds) {
    const rec = attachments.get(id, sessionId);
    if (!rec) continue;
    if (rec.mime.toLowerCase().startsWith('image/')) return rec.stored_path;
  }
  return undefined;
}

/**
 * Chat-based image models (OWUI `gemini-*-image`) intermittently answer a terse prompt
 * with prose — asking which style the user wants instead of drawing. Retry once with an
 * explicit draw directive before reporting failure.
 */
const OWUI_IMAGE_DIRECTIVE =
  'Generate the image now. Output only the generated image, no questions and no style options.';

async function requestOwuiImage(opts: {
  cloudChat: CloudChatService;
  providerStore: ProviderStore;
  cqrRoot: string;
  imageOut: string;
  message: string;
  sessionId: string;
  resolved: ResolvedModelRoute & { route: { type: 'provider'; providerId: string; modelId?: string } };
  systemPrompt?: string;
}): Promise<{ content: string; imageUrls: string[]; model: string }> {
  const { cloudChat, providerStore, cqrRoot, imageOut, message, sessionId, resolved } = opts;
  const out = await cloudChat.complete(
    resolved.route.providerId,
    message,
    undefined,
    [],
    opts.systemPrompt,
    { modelId: resolved.route.modelId, timeoutMs: 300_000 },
  );
  const finalized = await ingestOwuiChatImages({
    content: out.content,
    providerStore,
    providerId: resolved.route.providerId,
    sessionId,
    imageOutDir: imageOut,
    cqrRoot,
    maxImages: 1,
  });
  return { content: finalized.content, imageUrls: finalized.imageUrls, model: out.model };
}

async function generateImageViaOwui(opts: {
  cloudChat: CloudChatService;
  providerStore: ProviderStore;
  cqrRoot: string;
  imageOut: string;
  message: string;
  sessionId: string;
  resolved: ResolvedModelRoute;
}): Promise<{ content: string; imageUrls: string[]; model: string }> {
  const { resolved } = opts;
  if (resolved.route.type !== 'provider') {
    throw new Error('OWUI_IMAGE_NO_PROVIDER');
  }
  const attemptOpts = { ...opts, resolved: resolved as Parameters<typeof requestOwuiImage>[0]['resolved'] };

  const first = await requestOwuiImage(attemptOpts);
  if (first.imageUrls.length > 0) return first;

  const retry = await requestOwuiImage({ ...attemptOpts, systemPrompt: OWUI_IMAGE_DIRECTIVE });
  if (retry.imageUrls.length > 0) return retry;
  return { ...retry, content: retry.content || first.content };
}

async function generateLocalImage(opts: {
  imageBackend: AutoImageBackend;
  cqrRoot: string;
  imageOut: string;
  prompt: string;
  sessionId: string;
  initImagePath?: string;
}) {
  const { imageBackend, cqrRoot, imageOut, prompt, sessionId, initImagePath } = opts;
  const id = randomUUID();
  const dir = path.join(imageOut, sessionId);
  mkdirSync(dir, { recursive: true });
  const outputPath = path.join(dir, `${id}.png`);
  assertWritablePath(outputPath, cqrRoot);
  const result = await imageBackend.generate(
    { prompt, sessionId, initImagePath, width: 512, height: 512 },
    outputPath,
  );
  result.url = `/outputs/images/${sessionId}/${id}.png`;
  return result;
}

export async function handleImageGenMode(opts: {
  attachments: AttachmentService;
  cloudChat: CloudChatService;
  imageBackend: AutoImageBackend;
  providerStore: ProviderStore;
  sessionStore: SessionStore;
  cqrRoot: string;
  imageOut: string;
  sessionId: string;
  message: string;
  routing: RouteDecision;
  resolved: ResolvedModelRoute;
  attachmentIds: string[];
}): Promise<ChatResponse> {
  const {
    attachments,
    cloudChat,
    imageBackend,
    providerStore,
    sessionStore,
    cqrRoot,
    imageOut,
    sessionId,
    message,
    routing,
    resolved,
    attachmentIds,
  } = opts;

  const initPath = resolveInitImage(attachments, attachmentIds, sessionId);

  if (resolved.route.type === 'provider') {
    const def = providerStore.getDefinition(resolved.route.providerId);
    if (def?.custom) {
      let owuiFail: string | null = null;
      let modelReply: string | null = null;
      try {
        const owui = await generateImageViaOwui({
          cloudChat,
          providerStore,
          cqrRoot,
          imageOut,
          message,
          sessionId,
          resolved,
        });
        if (owui.imageUrls.length > 0) {
          const content = appendAssistantReply(sessionStore, sessionId, {
            content: owui.content || '이미지를 생성했습니다.',
            model: owui.model,
            mode: 'image_gen',
            image_urls: owui.imageUrls,
          });
          return {
            role: 'assistant',
            content,
            mode: 'image_gen',
            routing,
            model: owui.model,
            image: { url: owui.imageUrls[0] },
            images: owui.imageUrls.map((url) => ({ url })),
          };
        }
        owuiFail = '이미지 모델이 두 번 모두 이미지 대신 텍스트로 답했습니다.';
        modelReply = owui.content.trim() || null;
      } catch (e: unknown) {
        owuiFail = e instanceof Error ? e.message : String(e);
      }
      const content = appendAssistantReply(sessionStore, sessionId, {
        content: [
          '**MY OpenRouter 이미지 생성 실패**',
          '',
          owuiFail ?? '알 수 없는 오류',
          ...(modelReply
            ? ['', '모델 응답:', '', `> ${modelReply.slice(0, 400).replace(/\n/g, '\n> ')}`]
            : []),
          '',
          modelReply
            ? '프롬프트를 더 구체적으로 적고 다시 시도하세요 (예: 「미니멀한 검은 고양이 로고, 흰 배경」).'
            : '확인: 모델 탭 → MY OpenRouter API 키 · `gemini-3-pro-image (이미지 생성)` · 🎨 이미지 활성화',
        ].join('\n'),
        model: resolved.display,
        mode: 'image_gen',
      });
      return {
        role: 'assistant',
        content,
        mode: 'image_gen',
        routing,
        model: resolved.display,
      };
    }
  }

  const result = await generateLocalImage({
    imageBackend,
    cqrRoot,
    imageOut,
    prompt: message,
    sessionId,
    initImagePath: initPath,
  });
  const content = appendAssistantReply(sessionStore, sessionId, {
    content: result.stub
      ? `이미지 생성(스텁) 완료 — sd.exe 미설치 시 플레이스홀더입니다.\n프롬프트: ${message}`
      : `이미지를 생성했습니다.\n프롬프트: ${message}`,
    model: resolved.display,
    mode: 'image_gen',
    image_urls: [result.url],
  });
  return {
    role: 'assistant',
    content,
    mode: 'image_gen',
    routing,
    model: resolved.display,
    image: { url: result.url, seed: result.seed },
    images: [{ url: result.url }],
  };
}
