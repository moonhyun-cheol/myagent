/**
 * Persist model-generated images extracted from provider payloads and decide
 * what the user sees when some results could not be stored.
 *
 * Success is only claimed for files that passed signature/size checks and were
 * written to disk (docs/media-output-persistence-plan.md P0-3, P0-5).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import type { ApplicationNotice } from '../sessions/types.js';
import type { GeneratedMedia } from './generated-media-extract.js';
import { saveMediaBuffer, type MediaRecord } from './media-store.js';

export function safeSessionSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'session';
}

export interface PersistGeneratedImagesResult {
  media: MediaRecord[];
  /** Inline payloads that failed validation or write. */
  failed: number;
  /** Results that cannot be stored by design (remote URL, video, unknown shape). */
  unsupported: number;
  /** Failed payloads whose raw data was kept in the recovery area. */
  recovered: number;
}

/**
 * Recovery area for generated images that failed validation/write (P1-4).
 * Kept apart from token logs, chat history and model context: nothing here is
 * read back automatically. Bounded by per-item size, per-session count and age.
 */
export const MEDIA_RECOVERY_LIMITS = {
  /** base64 characters per record (~30MB decoded). */
  maxItemChars: 40 * 1024 * 1024,
  maxPerSession: 20,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
};

export function mediaRecoveryRoot(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'media-recovery');
}

function pruneRecoveryDir(dir: string, now: number): number {
  let kept = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    try {
      if (now - statSync(full).mtimeMs > MEDIA_RECOVERY_LIMITS.maxAgeMs) rmSync(full, { force: true });
      else kept += 1;
    } catch { /* ignore unreadable entry */ }
  }
  return kept;
}

function writeRecoveryRecord(
  payload: { base64: string; mime?: string },
  reason: string,
  opts: { cqrRoot: string; segment: string; model?: string },
): boolean {
  if (!payload.base64 || payload.base64.length > MEDIA_RECOVERY_LIMITS.maxItemChars) return false;
  try {
    const dir = path.join(mediaRecoveryRoot(opts.cqrRoot), opts.segment);
    const now = Date.now();
    if (pruneRecoveryDir(dir, now) >= MEDIA_RECOVERY_LIMITS.maxPerSession) return false;
    const full = path.join(dir, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
    assertWritablePath(full, opts.cqrRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(full, JSON.stringify({
      version: 1,
      at: new Date(now).toISOString(),
      session: opts.segment,
      ...(opts.model ? { model: opts.model } : {}),
      ...(payload.mime ? { declared_mime: payload.mime } : {}),
      reason: reason.slice(0, 300),
      base64: payload.base64,
    }));
    return true;
  } catch {
    return false;
  }
}

export function persistGeneratedImages(
  generated: GeneratedMedia | undefined,
  opts: {
    imageOutDir: string;
    sessionId: string;
    cqrRoot: string;
    /** sha256 values already stored for this reply (e.g. via OWUI file refs). */
    knownSha256?: Iterable<string>;
    maxImages?: number;
    /** Recorded with recovery entries only. */
    model?: string;
  },
): PersistGeneratedImagesResult {
  const out: PersistGeneratedImagesResult = {
    media: [], failed: 0, unsupported: generated?.unsupported ?? 0, recovered: 0,
  };
  if (!generated?.images.length) return out;
  const segment = safeSessionSegment(opts.sessionId);
  const seen = new Set(opts.knownSha256 ?? []);
  const cap = opts.maxImages && opts.maxImages > 0 ? opts.maxImages : Infinity;
  for (const img of generated.images) {
    if (out.media.length >= cap) break;
    try {
      const record = saveMediaBuffer(Buffer.from(img.base64, 'base64'), {
        expectKind: 'image',
        dir: path.join(opts.imageOutDir, segment),
        urlPrefix: `/outputs/images/${segment}`,
        cqrRoot: opts.cqrRoot,
      });
      if (seen.has(record.sha256)) continue;
      seen.add(record.sha256);
      out.media.push(record);
    } catch (e) {
      out.failed += 1;
      const reason = e instanceof Error ? e.message : String(e);
      if (writeRecoveryRecord(img, reason, { cqrRoot: opts.cqrRoot, segment, model: opts.model })) {
        out.recovered += 1;
      }
    }
  }
  return out;
}

/** Host notice for results that were returned but not stored — never shown as success. */
export function unverifiedMediaNotice(
  result: Pick<PersistGeneratedImagesResult, 'failed' | 'unsupported'> & { recovered?: number },
  model?: string,
): ApplicationNotice | undefined {
  const missing = result.failed + result.unsupported;
  if (missing <= 0) return undefined;
  const reasons: string[] = [];
  if (result.failed) reasons.push(`검사 또는 저장 실패 ${result.failed}개`);
  if (result.unsupported) reasons.push(`지원하지 않는 형식·외부 주소 ${result.unsupported}개`);
  const recoveredNote = result.recovered
    ? ` 저장하지 못한 원본 ${result.recovered}개는 복구용 기록(data/media-recovery)에 14일 동안 보관합니다.`
    : '';
  return {
    kind: 'failure',
    title: '생성 결과 확인 안 됨',
    message: `모델이 보낸 생성 결과 중 ${missing}개를 파일로 저장하지 못했습니다 (${reasons.join(', ')}). 저장되지 않은 결과는 생성 성공으로 표시하지 않습니다.${recoveredNote}`,
    ...(model ? { model } : {}),
  };
}
