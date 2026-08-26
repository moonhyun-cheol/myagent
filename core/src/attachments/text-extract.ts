import type { AttachmentService } from './attachment-service.js';
import { extractDocxText } from './docx-extract.js';
import { extractPdfText, extractPdfTextLegacy } from './pdf-extract.js';
import { mimeFromFilename } from './types.js';
import { runMarkitdownSidecar } from '../sidecars/markitdown-sidecar.js';
import {
  extractVideoKeyframeDataUrls,
  isVideoAttachment,
  MAX_VIDEO_BYTES,
} from './video-keyframes.js';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico']);
const MARKITDOWN_ATTACHMENT_EXTENSIONS = new Set([
  'xlsx',
  'xls',
  'xlsm',
  'pptx',
  'msg',
  'eml',
  'epub',
]);

export function isMarkitdownAttachment(name: string): boolean {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MARKITDOWN_ATTACHMENT_EXTENSIONS.has(ext);
}

function extractMarkitdownAttachment(
  storedPath: string,
  originalName: string,
  maxChars: number,
  cqrRoot?: string,
): string {
  const result = runMarkitdownSidecar({ filePath: storedPath, cqrRoot });
  const markdown = String(result.rawLog ?? '').trim();
  if (result.ok && markdown) return markdown.slice(0, Math.max(1, maxChars));
  return `[문서 첨부: ${originalName} — MarkItDown 변환 실패 (${result.error ?? 'UNKNOWN'}). ${result.summaryKo}]`;
}

function isTextLikeAttachment(name: string, mime: string): boolean {
  const lowerMime = mime.toLowerCase();
  if (lowerMime.startsWith('text/')) return true;
  if (lowerMime.startsWith('video/')) return false;
  if (
    lowerMime === 'application/json' ||
    lowerMime === 'application/jsonl' ||
    lowerMime === 'application/xml' ||
    lowerMime === 'application/javascript' ||
    lowerMime === 'application/sql' ||
    lowerMime === 'application/yaml' ||
    lowerMime === 'application/toml' ||
    lowerMime === 'application/x-sh' ||
    lowerMime === 'application/x-php'
  ) {
    return true;
  }

  const base = name.trim().toLowerCase();
  if (base === 'dockerfile' || base === 'makefile' || base === '.gitignore' || base === '.env') {
    return true;
  }

  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (!ext) return false;
  if (IMAGE_EXTENSIONS.has(ext)) return false;
  if (isVideoAttachment(name, mime)) return false;
  if (['pdf', 'docx', 'xlsx', 'zip', 'gz', 'wasm', 'exe', 'dll', 'bin', 'ocx', 'enc'].includes(ext)) {
    return false;
  }
  return true;
}

export async function buildAttachmentContext(
  attachmentIds: string[],
  attachments: AttachmentService,
  sessionId: string,
  maxChars = 12000,
  opts?: { cqrRoot?: string },
): Promise<string> {
  const parts: string[] = [];
  let total = 0;

  for (const id of attachmentIds) {
    const rec = attachments.get(id, sessionId);
    if (!rec) continue;
    const bytes = attachments.readBytes(id, sessionId);
    if (!bytes) continue;

    const ext = rec.original_name.split('.').pop()?.toLowerCase();
    const mime = rec.mime || mimeFromFilename(rec.original_name);
    let text = '';
    if (isMarkitdownAttachment(rec.original_name)) {
      text = extractMarkitdownAttachment(
        rec.stored_path,
        rec.original_name,
        maxChars - total,
        opts?.cqrRoot,
      );
    } else if (isTextLikeAttachment(rec.original_name, mime)) {
      text = bytes.toString('utf8');
    } else if (ext === 'docx') {
      text = await extractDocxText(bytes, maxChars - total);
    } else if (ext === 'pdf') {
      text = await extractPdfText(bytes, maxChars - total);
    } else if (IMAGE_EXTENSIONS.has(ext ?? '') || mime.toLowerCase().startsWith('image/')) {
      text = `[이미지 첨부: ${rec.original_name} — 모델에 이미지로 전달됨]`;
    } else if (isVideoAttachment(rec.original_name, mime)) {
      if (bytes.length > MAX_VIDEO_BYTES) {
        text = `[영상 첨부: ${rec.original_name} — 파일이 너무 큼 (${bytes.length} bytes, max ${MAX_VIDEO_BYTES}). 짧은 클립으로 다시 첨부하세요.]`;
      } else {
        const frames = extractVideoKeyframeDataUrls(rec.stored_path, {
          cqrRoot: opts?.cqrRoot,
          maxFrames: 4,
        });
        text = frames.ok
          ? `[영상 첨부: ${rec.original_name} — 키프레임 ${frames.dataUrls.length}장 vision으로 전달됨${
              frames.durationSec != null ? ` · ~${Math.round(frames.durationSec)}s` : ''
            }. 장면·UI·카피를 프레임 근거로 답하세요.]`
          : `[영상 첨부: ${rec.original_name} — 프레임 추출 실패 (${frames.note}). 첫 사용 시 tools/bootstrap-ffmpeg.ps1로 자동 설치를 시도합니다.]`;
      }
    } else {
      text = `[첨부: ${rec.original_name}, ${mime}, ${rec.size_bytes} bytes]`;
    }

    const chunk = `### ${rec.original_name}\n${text}\n`;
    if (total + chunk.length > maxChars) {
      parts.push(chunk.slice(0, maxChars - total));
      break;
    }
    parts.push(chunk);
    total += chunk.length;
  }

  return parts.join('\n');
}

const MAX_VISION_IMAGES = 6;
const MAX_VISION_BYTES = 5_000_000;

/** Build data-URL list for multimodal chat (images + video keyframes). */
export function collectAttachmentImageDataUrls(
  attachmentIds: string[],
  attachments: AttachmentService,
  sessionId: string,
  opts?: { cqrRoot?: string },
): string[] {
  const urls: string[] = [];
  for (const id of attachmentIds) {
    if (urls.length >= MAX_VISION_IMAGES) break;
    const rec = attachments.get(id, sessionId);
    if (!rec) continue;
    const mime = (rec.mime || mimeFromFilename(rec.original_name)).toLowerCase();
    const ext = rec.original_name.split('.').pop()?.toLowerCase() ?? '';

    if (isVideoAttachment(rec.original_name, mime)) {
      const bytes = attachments.readBytes(id, sessionId);
      if (!bytes || bytes.length > MAX_VIDEO_BYTES) continue;
      const remain = MAX_VISION_IMAGES - urls.length;
      const frames = extractVideoKeyframeDataUrls(rec.stored_path, {
        cqrRoot: opts?.cqrRoot,
        maxFrames: Math.min(4, remain),
      });
      for (const u of frames.dataUrls) {
        if (urls.length >= MAX_VISION_IMAGES) break;
        urls.push(u);
      }
      continue;
    }

    if (!mime.startsWith('image/') && !IMAGE_EXTENSIONS.has(ext)) continue;
    if (ext === 'svg') continue;
    const bytes = attachments.readBytes(id, sessionId);
    if (!bytes || bytes.length > MAX_VISION_BYTES) continue;
    const outMime = mime.startsWith('image/') ? mime.split(';')[0]!.trim() : mimeFromFilename(rec.original_name);
    urls.push(`data:${outMime};base64,${bytes.toString('base64')}`);
  }
  return urls;
}

/** @internal test helper */
export function extractPdfTextForTest(bytes: Buffer, max = 5000): string {
  return extractPdfTextLegacy(bytes, max);
}
