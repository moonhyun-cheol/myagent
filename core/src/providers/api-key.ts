/**
 * API keys travel in an HTTP header, so they must stay a single line. Keys pasted with a
 * trailing note, docs URL or file path keep the extra lines otherwise, and every provider
 * call then dies with an opaque `Headers.append ... invalid header value` error instead of
 * a usable message.
 */
export function sanitizeApiKey(raw: string): string {
  const firstLine = raw.split(/[\r\n]/).find((line) => line.trim());
  return (firstLine ?? '').trim();
}
