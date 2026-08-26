/** Clipboard / drag-drop file helpers for the workspace composer. */

export function clipboardImageExt(mime: string): string {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  if (m === 'image/bmp') return 'bmp';
  return 'png';
}

export function isImageFile(file: File | null | undefined): boolean {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(file.name || '');
}

export function isClipboardImageFile(file: File | null | undefined): boolean {
  if (!file) return false;
  if (isImageFile(file)) return true;
  // Win+Shift+S / some WebView2: empty type, generic name
  const type = String(file.type || '').toLowerCase();
  if (!type && file.size > 32) return true;
  return false;
}

/** Any files from drag-drop or Explorer paste (no MIME allowlist). */
export function filesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data?.files?.length) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  for (const file of Array.from(data.files)) {
    if (!file) continue;
    const key = `${file.name}:${file.size}:${file.lastModified || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

export function stampPasteName(mime: string): string {
  const ext = clipboardImageExt(mime);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `paste-${stamp}.${ext}`;
}

export function filesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<string>();

  const pushFile = (file: File | null, mimeHint?: string) => {
    if (!file || !isClipboardImageFile(file)) return;
    const mime = mimeHint || file.type || 'image/png';
    const name =
      file.name && file.name !== 'image.png' && !/^image\./i.test(file.name)
        ? file.name
        : stampPasteName(mime);
    const key = `${name}:${file.size}:${file.lastModified || 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (file.name === name && file.type) {
      out.push(file);
      return;
    }
    out.push(new File([file], name, { type: mime, lastModified: file.lastModified || Date.now() }));
  };

  if (data.files?.length) {
    for (const file of Array.from(data.files)) pushFile(file);
  }

  if (!out.length && data.items?.length) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      if (!item.type.startsWith('image/') && item.type !== '') continue;
      pushFile(item.getAsFile(), item.type || undefined);
    }
  }

  return out;
}

export async function filesFromClipboardApi(): Promise<File[]> {
  if (!navigator.clipboard?.read) return [];
  try {
    const items = await navigator.clipboard.read();
    const out: File[] = [];
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      const mime = type || 'image/png';
      out.push(new File([blob], stampPasteName(mime), { type: mime }));
    }
    return out;
  } catch {
    return [];
  }
}
