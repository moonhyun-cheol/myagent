import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProviderStore } from '../../providers/provider-store.js';
import type { SessionStore } from '../../sessions/session-store.js';
import type { ChatResponse, RouteDecision } from '../../router/types.js';
import type { ResolvedModelRoute } from '../../providers/types.js';
import { assertWritablePath } from '../../security/path-guard.js';
import { appendAssistantReply } from '../assistant-reply.js';
import { generateVideo } from '../../video/video-generation.js';
import { hasOrganizationVideoAccess, type VideoModelDef } from '../../video/video-models.js';

export const VIDEO_MODEL_ORG_REQUIRED_MESSAGE = [
  '**동영상 모델을 사용할 수 없습니다**',
  '',
  '동영상 모델(Veo · Seedance)은 조직 모듈이 설치된 PC에서만 사용할 수 있습니다.',
  '다른 모델로 대신 답하지 않았습니다. 일반 모델을 선택해 다시 보내 주세요.',
].join('\n');

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'session';
}

export function videoUrlFor(sessionId: string, file: string): string {
  return `/outputs/videos/${safeSegment(sessionId)}/${file}`;
}

export async function handleVideoGenMode(opts: {
  providerStore: ProviderStore;
  sessionStore: SessionStore;
  cqrRoot: string;
  videoOut: string;
  sessionId: string;
  message: string;
  routing: RouteDecision;
  resolved: ResolvedModelRoute;
  model: VideoModelDef;
  signal?: AbortSignal;
  onStatus?: (text: string) => void;
}): Promise<ChatResponse> {
  const { providerStore, sessionStore, cqrRoot, videoOut, sessionId, message, routing, resolved, model } = opts;
  const reply = (content: string, modelLabel: string, videoUrl?: string): ChatResponse => {
    const stored = appendAssistantReply(sessionStore, sessionId, {
      content,
      model: modelLabel,
      mode: routing.mode,
      ...(videoUrl ? { image_urls: [videoUrl] } : {}),
    });
    return {
      role: 'assistant',
      content: stored,
      mode: routing.mode,
      routing,
      model: modelLabel,
      ...(videoUrl ? { images: [{ url: videoUrl }] } : {}),
    };
  };

  // Server-side gate: picker hiding is not enough.
  if (!hasOrganizationVideoAccess(cqrRoot)) {
    return reply(VIDEO_MODEL_ORG_REQUIRED_MESSAGE, 'video/organization_required');
  }
  if (resolved.route.type !== 'provider') {
    return reply('**동영상 생성 실패**\n\n동영상 모델은 MY OpenRouter 연결로만 호출할 수 있습니다.', model.id);
  }
  const def = providerStore.getDefinition(resolved.route.providerId);
  const secret = providerStore.getSecret(resolved.route.providerId);
  const baseUrl = (secret?.base_url || def?.base_url || '').trim();
  if (!def?.custom || !secret?.api_key || !baseUrl) {
    return reply(
      '**동영상 생성 실패**\n\nMY OpenRouter API 키가 설정되어 있지 않습니다. 모델 탭에서 연결을 확인하세요.',
      model.id,
    );
  }
  if (!message.trim()) {
    return reply('**동영상 생성 실패**\n\n만들 영상을 설명하는 프롬프트를 입력하세요.', model.id);
  }

  const file = `${randomUUID()}.mp4`;
  const outputPath = path.join(videoOut, safeSegment(sessionId), file);
  assertWritablePath(outputPath, cqrRoot);
  try {
    const out = await generateVideo({
      baseUrl,
      apiKey: secret.api_key,
      model,
      prompt: message,
      outputPath,
      signal: opts.signal,
      onStatus: opts.onStatus,
    });
    const mb = (out.bytes / (1024 * 1024)).toFixed(1);
    return reply(
      `동영상을 생성했습니다. (${model.label} · ${model.duration}초 · ${model.resolution} · ${mb}MB)`,
      model.id,
      videoUrlFor(sessionId, file),
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'VIDEO_ABORTED') throw e;
    return reply(`**동영상 생성 실패**\n\n${msg}`, model.id);
  }
}
