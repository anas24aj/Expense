/** File → base64 (no data: prefix), for /ingest/statement and /claims/import. */
export function readFile(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

/** A picked image → a JPEG data URL at most `size` px on its longer side, made smaller until it fits `maxChars`
 * (the API takes inline photos only: about 64 KB for people, 90 KB for assets). */
export async function photoDataUrl(f: File, size = 128, maxChars = 60_000): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That file isn’t an image we can read'));
    i.src = URL.createObjectURL(f);
  });
  try {
    for (let s = size, q = 0.85; s >= 32; q > 0.5 ? (q -= 0.15) : (s = Math.round(s * 0.75))) {
      const k = Math.min(1, s / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', q);
      if (url.length <= maxChars) return url;
    }
    throw new Error('That photo is too big even when shrunk');
  } finally {
    URL.revokeObjectURL(img.src);
  }
}
