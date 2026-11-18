import { mimeEssence } from '@trinity/util/matrix';
import { encodeBitmap } from './media-processing';

/** What the decode worker posts back; null when libheif found no image. */
export type HeicDecodeReply = {
  readonly width: number;
  readonly height: number;
  readonly rgba: ArrayBuffer;
} | null;

/** What the main thread sends the decode worker; `bytes` is transferred. */
export interface HeicDecodeRequest {
  readonly bytes: ArrayBuffer;
  readonly wasmUrl: string;
}

export const HEIC_DECODE_DEADLINE_MS = 30_000;

const HEIC_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);
const JPEG_QUALITY = 0.9;

/** The decode worker, or null where the host cannot start one. */
export function createHeicDecodeWorker(): Worker | null {
  if (typeof Worker === 'undefined') {
    return null;
  }
  try {
    return new Worker(new URL('./heic-decode.worker', import.meta.url), {
      type: 'module',
    });
  } catch {
    return null;
  }
}

function isHeic(file: File): boolean {
  const type = mimeEssence(file.type);
  return type ? HEIC_TYPES.has(type) : /\.hei[cf]$/i.test(file.name);
}

function jpegName(name: string): string {
  return name && name.replace(/\.[^./\\]*$/, '') + '.jpg';
}

/** Decode in a one-shot worker; null when it fails, finds no image or runs out of time. */
async function decodeInWorker(
  file: File,
  createWorker: () => Worker | null,
): Promise<ImageData | null> {
  const worker = createWorker();
  if (!worker) {
    return null;
  }
  try {
    const buffer = await file.arrayBuffer();
    const reply = await new Promise<HeicDecodeReply>((resolve) => {
      const timer = setTimeout(() => resolve(null), HEIC_DECODE_DEADLINE_MS);
      const settle = (value: HeicDecodeReply) => {
        clearTimeout(timer);
        resolve(value);
      };
      worker.onmessage = ({ data }: MessageEvent<HeicDecodeReply>) =>
        settle(data);
      worker.onerror = () => settle(null);
      worker.onmessageerror = () => settle(null);
      const request: HeicDecodeRequest = {
        bytes: buffer,
        wasmUrl: new URL('assets/heif/libheif.wasm', document.baseURI).href,
      };
      worker.postMessage(request, [buffer]);
    });
    return reply
      ? new ImageData(
          new Uint8ClampedArray(reply.rgba),
          reply.width,
          reply.height,
        )
      : null;
  } finally {
    worker.terminate();
  }
}

/**
 * Re-encodes a HEIC/HEIF image as JPEG so every client can show it. The platform decoder goes
 * first; libheif in a worker covers browsers that cannot read HEIC. Any failure returns the
 * original file, so an attachment is never lost to the conversion.
 */
export async function heicToJpeg(
  file: File,
  createWorker: () => Worker | null = createHeicDecodeWorker,
): Promise<File> {
  if (!isHeic(file) || typeof createImageBitmap !== 'function') {
    return file;
  }
  let bitmap: ImageBitmap | undefined;
  try {
    try {
      bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image',
      });
    } catch {
      const pixels = await decodeInWorker(file, createWorker);
      if (!pixels) {
        return file;
      }
      bitmap = await createImageBitmap(pixels);
    }
    const blob = await encodeBitmap(
      bitmap,
      bitmap.width,
      bitmap.height,
      'image/jpeg',
      JPEG_QUALITY,
    );
    return blob
      ? new File([blob], jpegName(file.name), {
          type: 'image/jpeg',
          lastModified: file.lastModified,
        })
      : file;
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
