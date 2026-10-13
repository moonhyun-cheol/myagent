import type { VideoModelDef } from './video-models.js';
import { saveMediaStream, type MediaRecord } from '../media/media-store.js';
import { guardedMediaFetch } from '../media/media-fetch.js';

/** Shown while the paid provider job runs: stopping here only stops local polling. */
export const VIDEO_STOP_HINT = '중지해도 공급자 쪽 생성과 비용은 계속될 수 있습니다';
export const VIDEO_SUBMITTED_STATUS = `동영상 생성 요청 접수 — 완료까지 수 분 걸릴 수 있습니다. ${VIDEO_STOP_HINT}.`;

/** OpenRouter async video API: POST /videos → poll polling_url → GET /videos/{id}/content. */
export interface VideoJobStatus {
  id?: string;
  status?: string;
  polling_url?: string;
  unsigned_urls?: string[];
  error?: unknown;
}

export interface GenerateVideoInput {
  baseUrl: string;
  apiKey: string;
  model: VideoModelDef;
  prompt: string;
  /** Where the verified video is stored (signature decides .mp4/.webm). */
  output: {
    dir: string;
    urlPrefix: string;
    baseName: string;
    cqrRoot: string;
    maxBytes?: number;
  };
  signal?: AbortSignal;
  onStatus?: (text: string) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GenerateVideoResult {
  jobId: string;
  bytes: number;
  media: MediaRecord;
}

/**
 * Failure after the provider accepted the job. `retryable` means the job may
 * still finish (or already finished) provider-side — retrieve it later instead
 * of submitting (and paying for) a new generation.
 */
export class VideoJobError extends Error {
  constructor(
    message: string,
    readonly jobId: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VideoJobError';
  }
}

export interface RetrieveVideoInput {
  baseUrl: string;
  apiKey: string;
  jobId: string;
  output: GenerateVideoInput['output'];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export type RetrieveVideoResult =
  | ({ state: 'completed' } & GenerateVideoResult)
  | { state: 'pending'; jobId: string; status: string };

const TERMINAL_FAIL = new Set(['failed', 'cancelled', 'canceled', 'expired']);

function errText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value && 'message' in value) {
    return String((value as { message: unknown }).message);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('VIDEO_ABORTED'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('VIDEO_ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return `HTTP ${res.status}${body ? `: ${body.slice(0, 400)}` : ''}`;
}

interface JobContext {
  doFetch: typeof fetch;
  base: string;
  origin: string;
  auth: Record<string, string>;
  output: GenerateVideoInput['output'];
  signal?: AbortSignal;
}

function jobContext(input: { baseUrl: string; apiKey: string; output: GenerateVideoInput['output']; signal?: AbortSignal; fetchImpl?: typeof fetch }): JobContext {
  const base = input.baseUrl.replace(/\/$/, '');
  return {
    doFetch: input.fetchImpl ?? fetch,
    base,
    origin: new URL(base).origin,
    auth: { Authorization: `Bearer ${input.apiKey}` },
    output: input.output,
    signal: input.signal,
  };
}

function terminalFailure(job: VideoJobStatus, jobId: string): VideoJobError | null {
  const status = String(job.status ?? '').toLowerCase();
  if (!TERMINAL_FAIL.has(status)) return null;
  return new VideoJobError(`VIDEO_JOB_${status.toUpperCase()} ${errText(job.error)}`.trim(), jobId, false);
}

async function pollJob(ctx: JobContext, job: VideoJobStatus, jobId: string): Promise<VideoJobStatus> {
  const pollUrl = job.polling_url
    ? new URL(job.polling_url, ctx.origin).toString()
    : `${ctx.base}/videos/${encodeURIComponent(jobId)}`;
  // polling_url comes from the provider response: re-checked, key only to the provider origin.
  const poll = await guardedMediaFetch(pollUrl, {
    doFetch: ctx.doFetch,
    trustedOrigin: ctx.origin,
    authHeaders: ctx.auth,
    signal: ctx.signal,
  });
  if (!poll.ok) throw new Error(`VIDEO_POLL_FAILED ${await readError(poll)}`);
  return { ...job, ...((await poll.json()) as VideoJobStatus) };
}

async function downloadJob(ctx: JobContext, job: VideoJobStatus, jobId: string): Promise<GenerateVideoResult> {
  const unsigned = job.unsigned_urls?.[0];
  const downloadUrl = unsigned
    ? new URL(unsigned, ctx.origin).toString()
    : `${ctx.base}/videos/${encodeURIComponent(jobId)}/content?index=0`;
  // https-only off-origin, private hosts blocked, bounded redirects, API key never
  // forwarded to a third-party storage host (each redirect hop re-checked).
  const dl = await guardedMediaFetch(downloadUrl, {
    doFetch: ctx.doFetch,
    trustedOrigin: ctx.origin,
    authHeaders: ctx.auth,
    signal: ctx.signal,
  });
  if (!dl.ok) throw new Error(`VIDEO_DOWNLOAD_FAILED ${await readError(dl)}`);
  const lengthHeader = dl.headers.get('content-length');
  let media: MediaRecord;
  try {
    // Streamed to disk with size cap + signature check (MP4/WebM only; HTML error pages rejected).
    media = await saveMediaStream(dl.body, {
      expectKind: 'video',
      ...ctx.output,
      contentLength: lengthHeader ? Number(lengthHeader) : null,
      signal: ctx.signal,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'MEDIA_ABORTED' || ctx.signal?.aborted) throw new Error('VIDEO_ABORTED');
    throw new Error(`VIDEO_DOWNLOAD_FAILED ${msg}`);
  }
  return { jobId, bytes: media.bytes, media };
}

/** Wrap post-submit failures so callers keep the job id (retrieve instead of regenerate). */
function asJobError(e: unknown, jobId: string, signal?: AbortSignal): VideoJobError {
  if (e instanceof VideoJobError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (signal?.aborted || (e instanceof Error && e.name === 'AbortError')) {
    return new VideoJobError('VIDEO_ABORTED', jobId, true);
  }
  return new VideoJobError(msg, jobId, true);
}

export async function generateVideo(
  input: GenerateVideoInput & { onSubmitted?: (jobId: string) => void },
): Promise<GenerateVideoResult> {
  const ctx = jobContext(input);
  const pollMs = input.pollIntervalMs ?? 10_000;
  const deadline = Date.now() + (input.timeoutMs ?? 15 * 60_000);

  const submit = await ctx.doFetch(`${ctx.base}/videos`, {
    method: 'POST',
    headers: { ...ctx.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: input.model.id,
      prompt: input.prompt,
      duration: input.model.duration,
      resolution: input.model.resolution,
      aspect_ratio: input.model.aspect_ratio,
      generate_audio: input.model.generate_audio,
    }),
    signal: input.signal,
  });
  if (!submit.ok) throw new Error(`VIDEO_SUBMIT_FAILED ${await readError(submit)}`);
  let job = (await submit.json()) as VideoJobStatus;
  const jobId = String(job.id ?? '').trim();
  if (!jobId) throw new Error('VIDEO_SUBMIT_FAILED 응답에 작업 id가 없습니다.');
  input.onSubmitted?.(jobId);
  input.onStatus?.(VIDEO_SUBMITTED_STATUS);

  try {
    while (job.status !== 'completed') {
      const failed = terminalFailure(job, jobId);
      if (failed) throw failed;
      if (Date.now() > deadline) throw new Error('VIDEO_TIMEOUT 생성이 제한 시간 안에 끝나지 않았습니다.');
      await sleep(pollMs, input.signal);
      job = await pollJob(ctx, job, jobId);
      input.onStatus?.(`동영상 생성 중… (${job.status ?? 'pending'}) · ${VIDEO_STOP_HINT}`);
    }
    return await downloadJob(ctx, job, jobId);
  } catch (e: unknown) {
    throw asJobError(e, jobId, input.signal);
  }
}

/**
 * One status check for an already-submitted job; downloads when completed.
 * Never submits a new generation (no extra provider cost).
 */
export async function retrieveVideoJob(input: RetrieveVideoInput): Promise<RetrieveVideoResult> {
  const ctx = jobContext(input);
  const jobId = input.jobId.trim();
  if (!jobId) throw new VideoJobError('VIDEO_JOB_ID_MISSING', jobId, false);
  try {
    const job = await pollJob(ctx, { id: jobId }, jobId);
    const failed = terminalFailure(job, jobId);
    if (failed) throw failed;
    if (job.status !== 'completed') {
      return { state: 'pending', jobId, status: String(job.status ?? 'pending') };
    }
    return { state: 'completed', ...(await downloadJob(ctx, job, jobId)) };
  } catch (e: unknown) {
    throw asJobError(e, jobId, input.signal);
  }
}
