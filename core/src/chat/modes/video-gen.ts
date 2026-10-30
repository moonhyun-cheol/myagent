import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProviderStore } from '../../providers/provider-store.js';
import type { SessionStore } from '../../sessions/session-store.js';
import type { ChatResponse, RouteDecision } from '../../router/types.js';
import type { ResolvedModelRoute } from '../../providers/types.js';
import { appendAssistantReply } from '../assistant-reply.js';
import { withFailureModelLine } from '../../agent/agent-failure-plane.js';
import { generateVideo, retrieveVideoJob, VideoJobError } from '../../video/video-generation.js';
import { findVideoModel, hasOrganizationVideoAccess, type VideoModelDef } from '../../video/video-models.js';
import type { MediaRecord } from '../../media/media-store.js';
import type { VideoJobRecord } from '../../sessions/types.js';
import { createLlmUsageCollector, withLlmUsageContext } from '../../providers/llm-usage-log.js';

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

const RETRIEVABLE_NOTE =
  '공급자 쪽 작업은 계속 진행 중일 수 있고, 이미 비용이 청구됐을 수 있습니다. 다시 생성하지 말고 「결과 다시 받기」로 확인하세요.';

function capError(msg: string): string {
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 400);
}

function resolveVideoProvider(providerStore: ProviderStore, providerId: string): { baseUrl: string; apiKey: string } | null {
  const def = providerStore.getDefinition(providerId);
  const secret = providerStore.getSecret(providerId);
  const baseUrl = (secret?.base_url || def?.base_url || '').trim();
  if (!def?.custom || !secret?.api_key || !baseUrl) return null;
  return { baseUrl, apiKey: secret.api_key };
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
  /** Fired when the stored reply carries a provider job (live UI shows 「결과 다시 받기」). */
  onVideoJob?: (job: VideoJobRecord) => void;
}): Promise<ChatResponse> {
  const { providerStore, sessionStore, cqrRoot, videoOut, sessionId, message, routing, resolved, model } = opts;
  // Billed cost shown under the video bubble (jobs report cost only, no tokens).
  const usageCollector = createLlmUsageCollector();
  const reply = (content: string, modelLabel: string, video?: MediaRecord, job?: VideoJobRecord): ChatResponse => {
    const usage = usageCollector.result();
    const stored = appendAssistantReply(sessionStore, sessionId, {
      ...(usage ? { usage } : {}),
      content,
      model: modelLabel,
      mode: routing.mode,
      // `image_urls` kept for older readers / carry; `media.kind` is authoritative.
      ...(video ? { image_urls: [video.url], media: [video] } : {}),
      ...(job ? { video_job: job } : {}),
    });
    if (job) opts.onVideoJob?.(job);
    return {
      role: 'assistant',
      content: stored,
      mode: routing.mode,
      routing,
      model: modelLabel,
      ...(video ? { images: [{ url: video.url }] } : {}),
      ...(usage ? { usage } : {}),
    };
  };

  // Server-side gate: picker hiding is not enough.
  if (!hasOrganizationVideoAccess(cqrRoot)) {
    return reply(VIDEO_MODEL_ORG_REQUIRED_MESSAGE, 'video/organization_required');
  }
  if (resolved.route.type !== 'provider') {
    return reply('**동영상 생성 실패**\n\n동영상 모델은 MY OpenRouter 연결로만 호출할 수 있습니다.', model.id);
  }
  const providerId = resolved.route.providerId;
  const conn = resolveVideoProvider(providerStore, providerId);
  if (!conn) {
    return reply(
      '**동영상 생성 실패**\n\nMY OpenRouter API 키가 설정되어 있지 않습니다. 모델 탭에서 연결을 확인하세요.',
      model.id,
    );
  }
  if (!message.trim()) {
    return reply('**동영상 생성 실패**\n\n만들 영상을 설명하는 프롬프트를 입력하세요.', model.id);
  }

  const segment = safeSegment(sessionId);
  let job: VideoJobRecord | undefined;
  try {
    const out = await withLlmUsageContext({ cqrRoot, sessionId, providerId, purpose: 'video', collect: usageCollector.collect }, () => generateVideo({
      baseUrl: conn.baseUrl,
      apiKey: conn.apiKey,
      model,
      prompt: message,
      output: {
        dir: path.join(videoOut, segment),
        urlPrefix: `/outputs/videos/${segment}`,
        baseName: randomUUID(),
        cqrRoot,
      },
      signal: opts.signal,
      onStatus: opts.onStatus,
      onSubmitted: (jobId) => {
        const now = new Date().toISOString();
        job = { job_id: jobId, provider_id: providerId, model_id: model.id, status: 'pending', submitted_at: now, updated_at: now };
        // Survives a stop before the reply is written (finalizeStoppedRun attaches it).
        sessionStore.notePendingVideoJob(sessionId, job);
      },
    }));
    const mb = (out.bytes / (1024 * 1024)).toFixed(1);
    return reply(
      `동영상을 생성했습니다. (${model.label} · ${model.duration}초 · ${model.resolution} · ${mb}MB)`,
      model.id,
      out.media,
      job ? { ...job, status: 'completed', updated_at: new Date().toISOString() } : undefined,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'VIDEO_ABORTED') throw e;
    if (e instanceof VideoJobError && job) {
      const record: VideoJobRecord = {
        ...job,
        status: e.retryable ? 'pending' : 'failed',
        updated_at: new Date().toISOString(),
        error: capError(msg),
      };
      return reply(
        `**동영상 생성 실패**\n\n${withFailureModelLine(msg, model.id)}${e.retryable ? `\n\n${RETRIEVABLE_NOTE}` : ''}`,
        model.id,
        undefined,
        record,
      );
    }
    return reply(`**동영상 생성 실패**\n\n${withFailureModelLine(msg, model.id)}`, model.id);
  }
}

export type RetrieveVideoOutcome =
  | { ok: true; state: 'completed' | 'pending' | 'failed'; video_job: VideoJobRecord; media?: MediaRecord[]; content?: string }
  | { ok: false; error: string; status: number };

/**
 * 「결과 다시 받기」: one provider status check for the stored job; downloads and
 * attaches the video when finished. Never submits a new (paid) generation.
 */
export async function retrieveStoredVideoJob(opts: {
  providerStore: ProviderStore;
  sessionStore: SessionStore;
  cqrRoot: string;
  videoOut: string;
  sessionId: string;
  jobId: string;
}): Promise<RetrieveVideoOutcome> {
  const { jobId } = opts;
  const key = `${opts.sessionId}\u0000${jobId}`;
  // One retrieve per job at a time (double click must not download twice).
  if (retrievesInFlight.has(key)) return { ok: false, status: 409, error: 'VIDEO_RETRIEVE_IN_PROGRESS' };
  retrievesInFlight.add(key);
  try {
    return await retrieveStoredVideoJobOnce(opts);
  } finally {
    retrievesInFlight.delete(key);
  }
}

const retrievesInFlight = new Set<string>();

async function retrieveStoredVideoJobOnce(opts: {
  providerStore: ProviderStore;
  sessionStore: SessionStore;
  cqrRoot: string;
  videoOut: string;
  sessionId: string;
  jobId: string;
}): Promise<RetrieveVideoOutcome> {
  const { providerStore, sessionStore, cqrRoot, videoOut, sessionId, jobId } = opts;
  if (!hasOrganizationVideoAccess(cqrRoot)) return { ok: false, status: 403, error: 'VIDEO_ORGANIZATION_REQUIRED' };
  const rec = sessionStore.load(sessionId);
  if (!rec) return { ok: false, status: 404, error: 'SESSION_NOT_FOUND' };
  const msg = rec.messages.find((m) => m.role === 'assistant' && m.video_job?.job_id === jobId);
  const stored = msg?.video_job;
  if (!stored) return { ok: false, status: 404, error: 'VIDEO_JOB_NOT_FOUND' };
  if (stored.status === 'completed') return { ok: true, state: 'completed', video_job: stored };
  if (stored.status === 'failed') return { ok: true, state: 'failed', video_job: stored };
  const model = findVideoModel(stored.model_id);
  const conn = resolveVideoProvider(providerStore, stored.provider_id);
  if (!model || !conn) return { ok: false, status: 409, error: 'VIDEO_PROVIDER_UNAVAILABLE' };

  const segment = safeSegment(sessionId);
  const now = () => new Date().toISOString();
  const usageCollector = createLlmUsageCollector();
  try {
    const out = await withLlmUsageContext({ cqrRoot, sessionId, providerId: stored.provider_id, purpose: 'video', collect: usageCollector.collect }, () => retrieveVideoJob({
      baseUrl: conn.baseUrl,
      apiKey: conn.apiKey,
      jobId,
      modelId: stored.model_id,
      output: { dir: path.join(videoOut, segment), urlPrefix: `/outputs/videos/${segment}`, baseName: randomUUID(), cqrRoot },
    }));
    if (out.state === 'pending') {
      const video_job: VideoJobRecord = { ...stored, updated_at: now(), error: `아직 생성 중 (${out.status})` };
      sessionStore.updateVideoJob(sessionId, jobId, { video_job });
      return { ok: true, state: 'pending', video_job };
    }
    const mb = (out.bytes / (1024 * 1024)).toFixed(1);
    const content = `동영상 결과를 다시 받았습니다. (${model.label} · ${model.duration}초 · ${model.resolution} · ${mb}MB)`;
    const video_job: VideoJobRecord = { ...stored, status: 'completed', updated_at: now() };
    delete video_job.error;
    // Cost arrives with the completed job; keep an earlier stored cost if this lookup carried none.
    const cost = usageCollector.result()?.cost_usd;
    const usage = cost !== undefined ? { ...(msg?.usage ?? {}), cost_usd: cost } : undefined;
    sessionStore.updateVideoJob(sessionId, jobId, { video_job, content, media: [out.media], ...(usage ? { usage } : {}) });
    return { ok: true, state: 'completed', video_job, media: [out.media], content };
  } catch (e: unknown) {
    const text = e instanceof Error ? e.message : String(e);
    const retryable = !(e instanceof VideoJobError) || e.retryable;
    const video_job: VideoJobRecord = { ...stored, status: retryable ? 'pending' : 'failed', updated_at: now(), error: capError(text) };
    sessionStore.updateVideoJob(sessionId, jobId, { video_job });
    return { ok: true, state: video_job.status, video_job };
  }
}
