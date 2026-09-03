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
};

export const DOCUMENT_SCRATCH = scratchConfig as DocumentScratchConfig;

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
