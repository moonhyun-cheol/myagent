import type { VideoModelDef } from './video-models.js';
import { saveMediaStream, type MediaRecord } from '../media/media-store.js';

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

export async function generateVideo(input: GenerateVideoInput): Promise<GenerateVideoResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/$/, '');
  const origin = new URL(base).origin;
  const auth = { Authorization: `Bearer ${input.apiKey}` };
  const pollMs = input.pollIntervalMs ?? 10_000;
  const deadline = Date.now() + (input.timeoutMs ?? 15 * 60_000);

  const submit = await doFetch(`${base}/videos`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
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
  input.onStatus?.('동영상 생성 요청 접수 — 완료까지 수 분 걸릴 수 있습니다…');

  while (job.status !== 'completed') {
    const status = String(job.status ?? '').toLowerCase();
    if (TERMINAL_FAIL.has(status)) {
      throw new Error(`VIDEO_JOB_${status.toUpperCase()} ${errText(job.error)}`.trim());
    }
    if (Date.now() > deadline) throw new Error('VIDEO_TIMEOUT 생성이 제한 시간 안에 끝나지 않았습니다.');
    await sleep(pollMs, input.signal);
    const pollUrl = job.polling_url
      ? new URL(job.polling_url, origin).toString()
      : `${base}/videos/${encodeURIComponent(jobId)}`;
    const poll = await doFetch(pollUrl, { headers: auth, signal: input.signal });
    if (!poll.ok) throw new Error(`VIDEO_POLL_FAILED ${await readError(poll)}`);
    job = { ...job, ...((await poll.json()) as VideoJobStatus) };
    input.onStatus?.(`동영상 생성 중… (${job.status ?? 'pending'})`);
  }

  const unsigned = job.unsigned_urls?.[0];
  const downloadUrl = unsigned
    ? new URL(unsigned, origin).toString()
    : `${base}/videos/${encodeURIComponent(jobId)}/content?index=0`;
  // Never forward the API key to a third-party storage host.
  const sameOrigin = new URL(downloadUrl).origin === origin;
  const dl = await doFetch(downloadUrl, { headers: sameOrigin ? auth : undefined, signal: input.signal });
  if (!dl.ok) throw new Error(`VIDEO_DOWNLOAD_FAILED ${await readError(dl)}`);
  const lengthHeader = dl.headers.get('content-length');
  let media: MediaRecord;
  try {
    // Streamed to disk with size cap + signature check (MP4/WebM only; HTML error pages rejected).
    media = await saveMediaStream(dl.body, {
      expectKind: 'video',
      ...input.output,
      contentLength: lengthHeader ? Number(lengthHeader) : null,
      signal: input.signal,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'MEDIA_ABORTED' || input.signal?.aborted) throw new Error('VIDEO_ABORTED');
    throw new Error(`VIDEO_DOWNLOAD_FAILED ${msg}`);
  }
  return { jobId, bytes: media.bytes, media };
}
