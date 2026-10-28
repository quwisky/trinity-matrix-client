import { mimeEssence } from '@trinity/util/matrix';
import type { MediaPayload } from '@trinity/util/matrix';
import type { MediaHints } from './media-pipeline.models';
import { UPLOAD_THUMBNAIL_PX } from './thumbnail-size';

export interface GeneratedThumbnail {
  blob: Blob;
  w: number;
  h: number;
}

interface MediaAnalysis {
  dims: { w?: number; h?: number; durationMs?: number };
  thumbnail: GeneratedThumbnail | null;
}

const THUMBNAIL_MIME = 'image/jpeg';
const THUMBNAIL_QUALITY = 0.8;
/** PNG sources re-encode as WebP instead, which keeps their transparency. */
const THUMBNAIL_ALPHA_MIME = 'image/webp';

/**
 * The only types a thumbnail is rendered from. Anything else (GIF, WebP, AVIF, HEIF,
 * SVG, BMP, ICO, TIFF, ...) may be animated, vector, or carry an alpha channel that a
 * JPEG re-encode would flatten to black, so it is shown as sent.
 */
const DOWNSCALED_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png']);

const METADATA_TIMEOUT_MS = 5000;

/** Poster seek offset (s), past any black first frame. */
const POSTER_SEEK_SECONDS = 1;

const POSTER_TIMEOUT_MS = 3000;

/**
 * Dimensions, duration and thumbnail for an upload. Hints from the host win; `analyzeMedia`
 * fills only what they leave out and is skipped when they leave out nothing.
 */
export async function describeMedia(
  file: File,
  hints: MediaHints | undefined,
): Promise<MediaAnalysis> {
  const known = analysisFromHints(hints);
  if (isCompleteFor(file, known)) {
    return known;
  }
  const probed = await analyzeMedia(file);
  return {
    dims: {
      w: known.dims.w ?? probed.dims.w,
      h: known.dims.h ?? probed.dims.h,
      durationMs: known.dims.durationMs ?? probed.dims.durationMs,
    },
    thumbnail: known.thumbnail ?? probed.thumbnail,
  };
}

/** The usable part of host hints: a whole size pair, a duration, a bounded thumbnail. */
function analysisFromHints(hints: MediaHints | undefined): MediaAnalysis {
  if (!hints) {
    return { dims: {}, thumbnail: null };
  }
  const w = positiveInteger(hints.width);
  const h = positiveInteger(hints.height);
  const durationMs = positiveInteger(hints.durationMs);
  const hinted = hints.thumbnail;
  const thumbW = positiveInteger(hinted?.w);
  const thumbH = positiveInteger(hinted?.h);
  // A host thumbnail larger than the bound a rendered one gets counts as missing, so a
  // full-size frame never ships as a "thumbnail".
  const thumbnail =
    hinted &&
    hinted.blob.size > 0 &&
    thumbW !== undefined &&
    thumbH !== undefined &&
    Math.max(thumbW, thumbH) <= UPLOAD_THUMBNAIL_PX
      ? { blob: hinted.blob, w: thumbW, h: thumbH }
      : null;
  return {
    dims: {
      ...(w !== undefined && h !== undefined ? { w, h } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
    thumbnail,
  };
}

function isCompleteFor(file: File, known: MediaAnalysis): boolean {
  const sized = known.dims.w !== undefined && known.dims.h !== undefined;
  if (file.type.startsWith('video/')) {
    return (
      sized && known.dims.durationMs !== undefined && known.thumbnail !== null
    );
  }
  if (file.type.startsWith('image/')) {
    return sized && known.thumbnail !== null;
  }
  return false;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/**
 * Probe a picked file's intrinsic dimensions/duration and, for images, render a
 * downscaled thumbnail. Best-effort: anything undecodable yields empty dims and a
 * null thumbnail so the upload still proceeds. Audio/video duration is reported in
 * milliseconds to match the Matrix `info.duration` field.
 */
async function analyzeMedia(file: File): Promise<MediaAnalysis> {
  if (file.type.startsWith('image/')) {
    return analyzeImage(file);
  }
  if (file.type.startsWith('video/')) {
    return analyzeVideo(file);
  }
  if (file.type.startsWith('audio/')) {
    return { dims: await probeAudioDuration(file), thumbnail: null };
  }
  return { dims: {}, thumbnail: null };
}

async function analyzeImage(file: File): Promise<MediaAnalysis> {
  // SVG can't be safely rasterized to a thumbnail and renders as a file card
  // anyway; createImageBitmap is absent outside a real browser/WebView.
  if (
    file.type === 'image/svg+xml' ||
    typeof createImageBitmap !== 'function'
  ) {
    return { dims: {}, thumbnail: null };
  }
  let bitmap: ImageBitmap;
  try {
    // `from-image` applies EXIF orientation during decode so the thumbnail and recorded
    // dimensions match the full image on every engine (some older WebViews default to `none`).
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { dims: {}, thumbnail: null };
  }
  try {
    const dims = { w: bitmap.width, h: bitmap.height };
    let thumbnail: GeneratedThumbnail | null = null;
    try {
      thumbnail = await renderThumbnail(bitmap);
    } catch {
      // best-effort: a render error must not fail the send
      thumbnail = null;
    }
    return { dims, thumbnail };
  } finally {
    bitmap.close();
  }
}

/**
 * Draw a decoded image onto a downscaled canvas and encode it as a JPEG. Null when the image
 * is already within the thumbnail bound (its original is a fine thumbnail) or no 2D canvas
 * is available.
 */
async function renderThumbnail(
  bitmap: ImageBitmap,
): Promise<GeneratedThumbnail | null> {
  if (typeof document === 'undefined') {
    return null;
  }
  const { w, h } = fitWithin(bitmap.width, bitmap.height, UPLOAD_THUMBNAIL_PX);
  if (w >= bitmap.width && h >= bitmap.height) {
    return null; // already small — the original doubles as its own thumbnail
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await canvasToBlob(canvas, THUMBNAIL_MIME, THUMBNAIL_QUALITY);
  return blob ? { blob, w, h } : null;
}

/** Whether an attachment is a JPEG/PNG the event does not already say fits within `edge` px. */
export function needsDownscale(
  { mimeType, width, height }: MediaPayload,
  edge: number,
): boolean {
  const known = width && height ? Math.max(width, height) : Infinity;
  return DOWNSCALED_MIMES.has(mimeEssence(mimeType)) && known > edge;
}

/** Whether PNG bytes carry an `acTL` (animation control) chunk before the first `IDAT`. */
export function isAnimatedPng(bytes: ArrayBuffer): boolean {
  const view = new DataView(bytes);
  for (let at = 8; at + 8 <= view.byteLength;) {
    const type = String.fromCharCode(
      ...new Uint8Array(bytes, at + 4, 4), // chunk header: 4-byte length, 4-byte type
    );
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    at += 12 + view.getUint32(at); // header + data + CRC
  }
  return false;
}

/**
 * Shrink a decrypted image to at most `maxEdge` px on its long edge. Best-effort:
 * an image already that small, or any decode/resize/encode failure, yields the
 * original so a thumbnail never fails because it could not be shrunk. With `force`, an
 * oversized image always comes back as the resized encode (alpha-safe unless JPEG), even
 * when that is larger in bytes.
 */
export async function downscaleImage(
  blob: Blob,
  maxEdge: number,
  { force = false }: { force?: boolean } = {},
): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') {
    return blob;
  }
  let decoded: ImageBitmap | undefined;
  let resized: ImageBitmap | undefined;
  const isPng = blob.type.toLowerCase() === 'image/png';
  try {
    if (isPng && isAnimatedPng(await blob.arrayBuffer())) {
      return blob; // an animated PNG would freeze on its first frame
    }
    // `from-image` applies EXIF orientation, as in analyzeImage.
    decoded = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const { w, h } = fitWithin(decoded.width, decoded.height, maxEdge);
    if (w >= decoded.width && h >= decoded.height) {
      return blob;
    }
    resized = await createImageBitmap(decoded, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    });
    // The full-size bitmap is the big one: free it before the encode, not after.
    decoded.close();
    decoded = undefined;
    const encoded = await encodeBitmap(
      resized,
      w,
      h,
      (force ? blob.type.toLowerCase() !== 'image/jpeg' : isPng)
        ? THUMBNAIL_ALPHA_MIME
        : THUMBNAIL_MIME,
    );
    return encoded && (force || encoded.size < blob.size) ? encoded : blob;
  } catch {
    return blob;
  } finally {
    decoded?.close();
    resized?.close();
  }
}

/** Draw a bitmap on an off-screen (else regular) canvas and encode it; null if it cannot. */
async function encodeBitmap(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  type: string,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(w, h);
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.drawImage(bitmap, 0, 0, w, h);
    return canvas.convertToBlob({ type, quality: THUMBNAIL_QUALITY });
  }
  if (typeof document === 'undefined') {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.drawImage(bitmap, 0, 0, w, h);
  return canvasToBlob(canvas, type, THUMBNAIL_QUALITY);
}

/** Scale (w, h) to fit within a max edge, preserving aspect; never upscales. */
function fitWithin(
  w: number,
  h: number,
  max: number,
): { w: number; h: number } {
  if (w <= max && h <= max) {
    return { w, h };
  }
  const scale = Math.min(max / w, max / h);
  // Clamp to >= 1 so an extreme aspect ratio (e.g. 10000×1) can't round an edge to 0.
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/** A media element's duration in ms, or undefined when unknown/zero/infinite. */
function durationMsOf(el: HTMLMediaElement): number | undefined {
  return Number.isFinite(el.duration) && el.duration > 0
    ? Math.round(el.duration * 1000)
    : undefined;
}

/**
 * Load an audio file's metadata off-screen to read its duration (ms). Resolves to
 * empty (never rejects) on error, or if metadata doesn't arrive within
 * {@link METADATA_TIMEOUT_MS}, so a corrupt file can't stall the send.
 */
function probeAudioDuration(file: File): Promise<{ durationMs?: number }> {
  return new Promise((resolve) => {
    if (
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      resolve({});
      return;
    }
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve({});
      return;
    }
    const el = document.createElement('audio');
    let settled = false;
    const finish = (result: { durationMs?: number }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      try {
        el.removeAttribute('src');
        el.load();
      } catch {
        /* element teardown is best-effort */
      }
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => finish({}), METADATA_TIMEOUT_MS);
    el.preload = 'metadata';
    el.onloadedmetadata = () => finish({ durationMs: durationMsOf(el) });
    el.onerror = () => finish({});
    el.src = url;
  });
}

/**
 * Load a video off-screen to read its dimensions/duration and capture a poster frame.
 * Metadata resolves first and survives a poster seek/decode failure or timeout
 * ({@link POSTER_TIMEOUT_MS}); the whole probe is bounded by {@link METADATA_TIMEOUT_MS} so a
 * corrupt file can't stall the send.
 */
function analyzeVideo(file: File): Promise<MediaAnalysis> {
  const EMPTY: MediaAnalysis = { dims: {}, thumbnail: null };
  return new Promise((resolve) => {
    if (
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      resolve(EMPTY);
      return;
    }
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve(EMPTY);
      return;
    }
    const video = document.createElement('video');
    let settled = false;
    const finish = (result: MediaAnalysis) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(metaTimer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.onseeked = null;
      try {
        video.removeAttribute('src');
        video.load();
      } catch {
        /* element teardown is best-effort */
      }
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const metaTimer = setTimeout(() => finish(EMPTY), METADATA_TIMEOUT_MS);
    // `auto` so seeking can decode a frame to draw (metadata alone may not).
    video.preload = 'auto';
    video.muted = true;
    video.onerror = () => finish(EMPTY); // before metadata → total failure
    video.onloadedmetadata = () => {
      // Metadata arrived: retire the metadata timeout so it can't discard the dims we now hold
      // (a slow load plus a longer poster wait could let it win). The poster timeout governs
      // from here.
      clearTimeout(metaTimer);
      const dims = {
        w: video.videoWidth || undefined,
        h: video.videoHeight || undefined,
        durationMs: durationMsOf(video),
      };
      // Metadata is in hand; a poster failure from here must NOT discard it.
      const posterTimer = setTimeout(
        () => finish({ dims, thumbnail: null }),
        POSTER_TIMEOUT_MS,
      );
      const finishWithPoster = (thumbnail: GeneratedThumbnail | null) => {
        clearTimeout(posterTimer);
        finish({ dims, thumbnail });
      };
      const capture = () =>
        drawPoster(video).then(finishWithPoster, () => finishWithPoster(null));
      video.onerror = () => finishWithPoster(null);
      video.onseeked = capture;
      // Seek a little past the start (clamped for short clips) to skip a black
      // opening frame; an unknown duration falls back to the first frame.
      const seekTo =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.min(POSTER_SEEK_SECONDS, video.duration / 2)
          : 0;
      if (seekTo === video.currentTime) {
        // No position change → no 'seeked' fires; capture the current frame now.
        capture();
      } else {
        try {
          video.currentTime = seekTo;
        } catch {
          finishWithPoster(null);
        }
      }
    };
    video.src = url;
  });
}

function drawPoster(
  video: HTMLVideoElement,
): Promise<GeneratedThumbnail | null> {
  if (
    typeof document === 'undefined' ||
    !video.videoWidth ||
    !video.videoHeight
  ) {
    return Promise.resolve(null);
  }
  const { w, h } = fitWithin(
    video.videoWidth,
    video.videoHeight,
    UPLOAD_THUMBNAIL_PX,
  );
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return Promise.resolve(null);
  }
  ctx.drawImage(video, 0, 0, w, h);
  return canvasToBlob(canvas, THUMBNAIL_MIME, THUMBNAIL_QUALITY).then((blob) =>
    blob ? { blob, w, h } : null,
  );
}

/** The Matrix `msgtype` for a file of this type. */
export function msgTypeFor(
  mime: string,
): 'm.image' | 'm.video' | 'm.audio' | 'm.file' {
  if (mime.startsWith('image/')) {
    return 'm.image';
  }
  if (mime.startsWith('video/')) {
    return 'm.video';
  }
  if (mime.startsWith('audio/')) {
    return 'm.audio';
  }
  return 'm.file';
}
