/** Protocol-only guards. Request intent and response meaning belong to the model. */

export function contentLooksLikeToolMimic(content: string): boolean {
  const text = content.trim();
  return Boolean(text) && (
    /<\/?tool_calls?\b/i.test(text)
    || /<invoke\s+name=/i.test(text)
    || /(?:^|\n)\s*(?:TOOL[_ ]?CALL|Tool\s*call)\s*:/i.test(text)
    || /✿FUNCTION✿/i.test(text)
  );
}

export function stripToolMimeticNoise(content: string): string {
  return content
    .replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, '')
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, '')
    .replace(/(?:^|\n)\s*(?:TOOL[_ ]?CALL|Tool\s*call)\s*:\s*\{[\s\S]*?\}(?=\s*(?:\n|$))/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeFinalAgentContent(content: string): string {
  return stripToolMimeticNoise(String(content || ''));
}

export function contentLooksLikeToolNotFoundPoison(content: string): boolean {
  return /(?:Tool not found|Unknown tool|unsupported\s+tool|invalid\s+tool)/i.test(content);
}

export function sanitizeToolNotFoundPoison(content: string): string | null {
  const cleaned = content
    .split('\n')
    .filter((line) => !contentLooksLikeToolNotFoundPoison(line))
    .join('\n')
    .trim();
  return cleaned || null;
}
