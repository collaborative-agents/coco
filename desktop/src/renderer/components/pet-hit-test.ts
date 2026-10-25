export type AlphaMask = { width: number; height: number; alpha: Uint8Array };

/** Map viewport coordinates through object-fit: contain and CSS scaling. */
export function hitsPet(
  mask: AlphaMask,
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): boolean {
  const scale = Math.min(rect.width / mask.width, rect.height / mask.height);
  if (scale <= 0) return false;
  const px = Math.floor(
    (x - rect.left - (rect.width - mask.width * scale) / 2) / scale,
  );
  const py = Math.floor(
    (y - rect.top - (rect.height - mask.height * scale) / 2) / scale,
  );
  return (
    px >= 0 &&
    py >= 0 &&
    px < mask.width &&
    py < mask.height &&
    mask.alpha[py * mask.width + px] >= 16
  );
}

const masks = new Map<string, AlphaMask>();

export function imageMask(img: HTMLImageElement): AlphaMask | undefined {
  if (!img.complete || !img.naturalWidth) return undefined;
  const key = img.currentSrc || img.src;
  const cached = masks.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const alpha = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3];
  const mask = { width: canvas.width, height: canvas.height, alpha };
  masks.set(key, mask);
  return mask;
}
