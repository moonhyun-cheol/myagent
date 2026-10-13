/**
 * Generated-media kind detection for chat turns.
 *
 * Core stores verified videos under `/outputs/videos/` and images under
 * `/outputs/images/` (signature-checked, see core media-store). The directory is
 * the kind; the extension check only covers legacy/foreign URLs.
 */
export function isVideoMediaUrl(url: string): boolean {
  if (url.startsWith('/outputs/videos/')) return true;
  if (url.startsWith('/outputs/images/')) return false;
  return /\.(mp4|webm)(?:$|[?#])/i.test(url);
}
