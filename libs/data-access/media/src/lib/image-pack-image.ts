import { mimeEssence } from '@trinity/util/matrix';
import type { ImagePackUsage } from './image-pack.model';
import { downscaleImage, isAnimatedPng } from './media-processing';

const EMOTICON_EDGE_PX = 256;
const STICKER_EDGE_PX = 512;
const MAX_ANIMATED_BYTES = 1_048_576;

export type ImagePackImageErrorCode = 'unsupported-type' | 'animated-too-large';

export class ImagePackImageError extends Error {
  constructor(readonly code: ImagePackImageErrorCode) {
    super(code);
    this.name = 'ImagePackImageError';
  }
}

/** Resize a pack image to its usage limit, or reject an unsupported or oversized animated one. */
export async function prepareImagePackImage(
  file: File,
  usage: readonly ImagePackUsage[],
): Promise<File> {
  const mimeType = mimeEssence(file.type);
  if (!mimeType.startsWith('image/') || mimeType === 'image/svg+xml') {
    throw new ImagePackImageError('unsupported-type');
  }
  if (await isAnimated(file, mimeType)) {
    if (file.size > MAX_ANIMATED_BYTES) {
      throw new ImagePackImageError('animated-too-large');
    }
    return file;
  }
  const edge = usage.includes('sticker') ? STICKER_EDGE_PX : EMOTICON_EDGE_PX;
  const scaled = await downscaleImage(file, edge, { force: true });
  if (scaled === file) return file;
  const ext = scaled.type === 'image/jpeg' ? 'jpg' : 'webp';
  return new File([scaled], file.name.replace(/\.[^.]*$/, '') + `.${ext}`, {
    type: scaled.type,
  });
}

async function isAnimated(file: File, mimeType: string): Promise<boolean> {
  // shortcut: every GIF counts as animated; parse its image blocks if static GIFs must be resized.
  if (mimeType === 'image/gif') return true;
  if (mimeType === 'image/png') return isAnimatedPng(await file.arrayBuffer());
  if (mimeType === 'image/webp') {
    const head = new Uint8Array(await file.slice(0, 21).arrayBuffer());
    const fourcc = String.fromCharCode(...head.slice(12, 16));
    return fourcc === 'VP8X' && head.length > 20 && (head[20] & 0x02) !== 0;
  }
  return false;
}
