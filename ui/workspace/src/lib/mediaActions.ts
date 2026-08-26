/** Clipboard / download helpers for chat + canvas media. */

export async function copyText(text: string): Promise<void> {
  const t = text.trim();
  if (!t) throw new Error('텍스트 없음');
  await navigator.clipboard.writeText(t);
}

export async function copyImageUrl(url: string): Promise<void> {
  const u = url.trim();
  if (!u) throw new Error('주소 없음');
  await navigator.clipboard.writeText(u);
}

async function blobFromImageUrl(url: string): Promise<Blob> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`이미지를 불러오지 못했습니다 (${res.status})`);
  return res.blob();
}

/** Best-effort image copy (ClipboardItem). Falls back to URL copy. */
export async function copyImageToClipboard(url: string): Promise<'image' | 'url'> {
  const blob = await blobFromImageUrl(url);
  const type = blob.type || 'image/png';
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      return 'image';
    } catch {
      /* fall through — some hosts block image clipboard */
    }
  }
  await navigator.clipboard.writeText(url);
  return 'url';
}

export function downloadImageUrl(url: string, filename = 'my-agent-image.png'): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[^\w.\-가-힣]+/g, '_').slice(0, 80) || 'my-agent-image.png';
  a.rel = 'noopener';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function guessImageFilename(title?: string, url?: string): string {
  const base = (title || 'my-agent-image').replace(/\s+/g, '-').slice(0, 48);
  const fromUrl = url?.match(/\.(png|jpe?g|webp|gif|bmp)(?:\?|$)/i)?.[1];
  return `${base}.${fromUrl || 'png'}`;
}
