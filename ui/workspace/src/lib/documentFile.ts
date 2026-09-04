/**
 * Document-tab path helpers. SSOT: core/config/defaults/document-scratch.json
 * Do not hardcode `.my-agent` paths in components.
 */
import scratchConfig from '../../../../core/config/defaults/document-scratch.json';

export type DocumentScratchConfig = {
  scratchDir: string;
  dumpsSubdir: string;
  projectDocsDir: string;
  allowedExtensions: string[];
  maxDumpsPerSession: number;
  gitignoreLine: string;
  gitignoreComment: string;
}

export function documentRecoveryRelPath(sessionId: string, tabId: string): string {
  const sid = String(sessionId || 'scratch')
    .trim()
    .replace(/[\\/]/g, '_');
  const tid = String(tabId || 'tab')
    .trim()
    .replace(/[\\/]/g, '_');
  return `${DOCUMENT_SCRATCH.scratchDir}/${sid}-${tid}.md`;
};

export const DOCUMENT_SCRATCH = scratchConfig as DocumentScratchConfig;

export type DocumentView = 'source' | 'preview' | 'diff';

export type DocumentMemoRange = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

export type DocumentMemo = {
  id: string;
  x: number;
  y: number;
  selection: string;
  range: DocumentMemoRange | null;
  question: string;
  answer: string;
  pending: boolean;
  turnId: string | null;
  /** false = collapsed to an Excel-style red-corner anchor. */
  open: boolean;
};

export type DocumentTab = {
  id: string;
  title: string;
  path: string | null;
  source: 'draft' | 'workspace' | 'import';
  content: string;
  dirty: boolean;
  selection: string;
  view: DocumentView;
  status: string | null;
  lastDumpPath: string | null;
  lastDumpContent: string | null;
  memos: DocumentMemo[];
  /** Workspace-relative recovery copy; never the user-visible project path. */
  recoveryPath?: string | null;
};

export function normalizeRelPath(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

export function isAllowedDocumentPath(relPath: string): boolean {
  const p = normalizeRelPath(relPath).toLowerCase();
  return DOCUMENT_SCRATCH.allowedExtensions.some((ext) => p.endsWith(ext.toLowerCase()));
}

export function sessionScratchRelPath(sessionId: string): string {
  // Legacy single-session scratch. Prefer documentRecoveryRelPath(sessionId, tabId).
  const sid = String(sessionId || '')
    .trim()
    .replace(/[\\/]/g, '_');
  return `${DOCUMENT_SCRATCH.scratchDir}/${sid}.md`;
}

export function dumpRelPath(sessionId: string, ts = Date.now()): string {
  const sid = String(sessionId || '')
    .trim()
    .replace(/[\\/]/g, '_');
  return `${DOCUMENT_SCRATCH.scratchDir}/${DOCUMENT_SCRATCH.dumpsSubdir}/${sid}-${ts}.md`;
}

export function dumpsDirRelPath(): string {
  return `${DOCUMENT_SCRATCH.scratchDir}/${DOCUMENT_SCRATCH.dumpsSubdir}`;
}

export function projectDocRelPath(title: string): string {
  const safe =
    String(title || 'untitled')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'untitled';
  const base = safe.toLowerCase().endsWith('.md') ? safe.slice(0, -3) : safe;
  return `${DOCUMENT_SCRATCH.projectDocsDir}/${base}.md`;
}

export function isDocumentScratchPath(relPath: string): boolean {
  const p = normalizeRelPath(relPath);
  const prefix = `${DOCUMENT_SCRATCH.scratchDir}/`;
  return p === DOCUMENT_SCRATCH.scratchDir || p.startsWith(prefix);
}

/** AI mutate → document tab: only project docs/, never scratch or README spam. */
export function isAiDocumentOpenPath(relPath: string): boolean {
  const p = normalizeRelPath(relPath);
  if (!isAllowedDocumentPath(p) || isDocumentScratchPath(p)) return false;
  const docs = DOCUMENT_SCRATCH.projectDocsDir.replace(/\/+$/, '');
  return p === docs || p.startsWith(`${docs}/`);
}

export function documentTitleFromPath(relPath: string): string {
  return normalizeRelPath(relPath).split('/').pop()?.trim() || '문서';
}

/** Reject path traversal and illegal filename characters. */
export function validateDocumentFileName(name: string): string | null {
  const raw = String(name || '').trim();
  if (!raw) return '파일 이름을 입력하세요.';
  if (/[\\/]/.test(raw)) return '파일 이름에 경로 구분자를 넣을 수 없습니다.';
  if (/[<>:"|?*\u0000-\u001f]/.test(raw)) return '사용할 수 없는 문자가 있습니다.';
  if (raw === '.' || raw === '..') return '잘못된 파일 이름입니다.';
  return null;
}

export function ensureDocumentExtension(name: string): string {
  const trimmed = String(name || '').trim();
  if (!trimmed) return 'untitled.md';
  const lower = trimmed.toLowerCase();
  if (DOCUMENT_SCRATCH.allowedExtensions.some((ext) => lower.endsWith(ext.toLowerCase()))) {
    return trimmed;
  }
  return `${trimmed}.md`;
}

export function joinDocumentSavePath(folderRel: string, fileName: string): string {
  const folder = normalizeRelPath(folderRel).replace(/\/+$/, '');
  const name = ensureDocumentExtension(fileName);
  return folder ? `${folder}/${name}` : name;
}

/** Sanitize preview href: allow http(s), mailto, relative; block javascript/data. */
export function sanitizePreviewHref(href: string): string | null {
  const raw = String(href || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return null;
  }
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('#') ||
    lower.startsWith('/') ||
    !/^[a-z][a-z0-9+.-]*:/i.test(raw)
  ) {
    return raw;
  }
  return null;
}
