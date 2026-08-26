/**
 * DOCX text extract — prefer mammoth (OSS), fall back to OOXML w:t regex.
 */
export async function extractDocxText(bytes: Buffer, maxChars: number): Promise<string> {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: bytes });
    const text = String(result.value || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 0) {
      return text.slice(0, maxChars);
    }
  } catch {
    /* fall through */
  }
  return extractDocxTextLegacy(bytes, maxChars);
}

/** Sync legacy path for callers that cannot await (tests / peek). */
export function extractDocxTextLegacy(bytes: Buffer, maxChars: number): string {
  const raw = bytes.toString('latin1');
  const parts: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const t = m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
    if (t) parts.push(t);
    if (parts.join(' ').length >= maxChars) break;
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length > 0) return text.slice(0, maxChars);
  return `[DOCX — 텍스트 추출 실패 (${bytes.length} bytes)]`;
}
