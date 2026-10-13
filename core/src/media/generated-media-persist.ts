/**
 * Persist model-generated images extracted from provider payloads and decide
 * what the user sees when some results could not be stored.
 *
 * Success is only claimed for files that passed signature/size checks and were
 * written to disk (docs/media-output-persistence-plan.md P0-3, P0-5).
 */
import path from 'node:path';
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
  },
): PersistGeneratedImagesResult {
  const out: PersistGeneratedImagesResult = { media: [], failed: 0, unsupported: generated?.unsupported ?? 0 };
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
    } catch {
      out.failed += 1;
    }
  }
  return out;
}

/** Host notice for results that were returned but not stored — never shown as success. */
export function unverifiedMediaNotice(
  result: Pick<PersistGeneratedImagesResult, 'failed' | 'unsupported'>,
  model?: string,
): ApplicationNotice | undefined {
  const missing = result.failed + result.unsupported;
  if (missing <= 0) return undefined;
  const reasons: string[] = [];
  if (result.failed) reasons.push(`검사 또는 저장 실패 ${result.failed}개`);
  if (result.unsupported) reasons.push(`지원하지 않는 형식·외부 주소 ${result.unsupported}개`);
  return {
    kind: 'failure',
    title: '생성 결과 확인 안 됨',
    message: `모델이 보낸 생성 결과 중 ${missing}개를 파일로 저장하지 못했습니다 (${reasons.join(', ')}). 저장되지 않은 결과는 생성 성공으로 표시하지 않습니다.`,
    ...(model ? { model } : {}),
  };
}
