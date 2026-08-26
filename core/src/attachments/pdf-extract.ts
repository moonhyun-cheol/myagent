/**
 * PDF text extract — prefer pdf-parse (OSS), fall back to naive stream scrape.
 */
export async function extractPdfText(bytes: Buffer, maxChars: number): Promise<string> {
  try {
    const mod = await import('pdf-parse');
    const pdfParse = (mod as { default?: (b: Buffer) => Promise<{ text?: string }> }).default ?? (mod as unknown as (b: Buffer) => Promise<{ text?: string }>);
    const data = await pdfParse(bytes);
    const text = String(data?.text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 32) return text.slice(0, maxChars);
  } catch {
    /* fall through */
  }
  return extractPdfTextLegacy(bytes, maxChars);
}

export function extractPdfTextLegacy(bytes: Buffer, maxChars: number): string {
  const raw = bytes.toString('latin1');
  const parts: string[] = [];
  const paren = /\(([^\\)]*(?:\\.[^\\)]*)*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = paren.exec(raw)) !== null && parts.join(' ').length < maxChars) {
    let t = m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')');
    t = t.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
    if (t.trim()) parts.push(t.trim());
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length > 32) return text.slice(0, maxChars);
  return `[PDF — 텍스트 추출 실패 또는 스캔 PDF (${bytes.length} bytes)]`;
}
