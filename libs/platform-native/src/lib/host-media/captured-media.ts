import { Capacitor } from '@capacitor/core';
import type { MediaResult } from '@capacitor/camera';

/** Which capture the composer asked for. */
export type CaptureKind = 'photo' | 'video';

/**
 * How this host takes photos and videos for the composer: the native camera plugin, the
 * browser's capture inputs on a phone, or not at all (desktop browsers and Electron).
 */
export type CaptureMode = 'native' | 'web' | 'none';

/** The permission a capture was refused. */
export type CapturePermission = 'camera' | 'photos';

/** A host-rendered thumbnail and its pixel size. */
export interface CaptureThumbnail {
  readonly blob: Blob;
  readonly w: number;
  readonly h: number;
}

/**
 * What the camera already measured. Structurally identical to `MediaHints` in
 * `@trinity/data-access/media`, which this host layer may not import; the composer passes one
 * where the other is expected and the compiler checks that they still agree.
 */
export interface CaptureHints {
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly thumbnail?: CaptureThumbnail;
}

/** One capture: the file to stage and what the camera knew about it. */
export interface CapturedMedia {
  readonly file: File;
  readonly hints: CaptureHints;
}

export interface CaptureOptions {
  /** Also keep the capture in the device's photo library (Settings › Privacy). */
  readonly saveToGallery: boolean;
  /**
   * The homeserver's upload limit in bytes; null or absent when unknown. It may still be
   * resolving when the camera opens: it is awaited only after a capture returns, so a slow
   * lookup never delays the camera and a cancelled capture never waits for it.
   */
  readonly maxBytes?: number | null | PromiseLike<number | null>;
}

/** Camera access, or photo-library access while saving is on, was refused. */
export class CapturePermissionDeniedError extends Error {
  constructor(readonly permission: CapturePermission) {
    super(
      permission === 'camera'
        ? 'Camera access is denied.'
        : 'Photo library access is denied.',
    );
    this.name = 'CapturePermissionDeniedError';
  }
}

/** The device reports no camera (the iOS Simulator, a camera-less tablet). */
export class NoCameraError extends Error {
  constructor() {
    super('This device has no camera.');
    this.name = 'NoCameraError';
  }
}

/** The capture is larger than the homeserver accepts. */
export class CaptureTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super('The capture is larger than the homeserver accepts.');
    this.name = 'CaptureTooLargeError';
  }
}

/** The one decision that drives both composer menus. */
export function captureModeFor(
  captureSupported: boolean,
  mobileOs: boolean,
): CaptureMode {
  if (captureSupported) return 'native';
  return mobileOs ? 'web' : 'none';
}

const FORMAT_MIME: Partial<Record<string, string>> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
};

const MIME_EXTENSION: Partial<Record<string, string>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/quicktime': 'mov',
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/3gpp': '3gp',
  'video/webm': 'webm',
};

/**
 * File extension and MIME type for a capture. The plugin's `format` leads ("Android and iOS
 * may return 'jpg' instead of 'jpeg'"); a missing or wrong-family format falls back to the
 * fetched blob's type, then to JPEG or MP4.
 */
export function captureFormat(
  kind: CaptureKind,
  format: string | undefined,
  blobType: string,
): { extension: string; mimeType: string } {
  const family = kind === 'photo' ? 'image/' : 'video/';
  const fallback = kind === 'photo' ? 'image/jpeg' : 'video/mp4';
  const named =
    FORMAT_MIME[(format ?? '').trim().toLowerCase().replace(/^\./u, '')];
  const essence = (blobType.split(';')[0] ?? '').trim().toLowerCase();
  const mimeType = named?.startsWith(family)
    ? named
    : MIME_EXTENSION[essence] && essence.startsWith(family)
      ? essence
      : fallback;
  return { extension: MIME_EXTENSION[mimeType] ?? 'bin', mimeType };
}

/** `'1920x1080'` → `{ width: 1920, height: 1080 }`; anything else → null. */
export function parseResolution(
  value: string | undefined,
): { width: number; height: number } | null {
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/iu.exec(value ?? '');
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Plugin seconds → Matrix milliseconds; undefined unless positive and finite. */
export function secondsToMs(seconds: number | undefined): number | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : undefined;
}

/**
 * `correctOrientation` rotates the pixels, but nothing promises `resolution` was measured
 * after the turn. The thumbnail was rendered from the corrected image, so a resolution whose
 * aspect disagrees with it is swapped rather than sent sideways.
 */
export function orientToThumbnail(
  resolution: { width: number; height: number },
  thumbnail: { w: number; h: number },
): { width: number; height: number } {
  const resolutionPortrait = resolution.height > resolution.width;
  const thumbnailPortrait = thumbnail.h > thumbnail.w;
  const comparable =
    resolution.width !== resolution.height && thumbnail.w !== thumbnail.h;
  return comparable && resolutionPortrait !== thumbnailPortrait
    ? { width: resolution.height, height: resolution.width }
    : resolution;
}

/** Decode the plugin's base64 thumbnail and measure it; null when it cannot be. */
async function decodeThumbnail(
  encoded: string,
): Promise<CaptureThumbnail | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const binary = atob(encoded.replace(/^data:[^,]*,/u, ''));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], {
      type: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg',
    });
    const bitmap = await createImageBitmap(blob);
    try {
      return bitmap.width > 0 && bitmap.height > 0
        ? { blob, w: bitmap.width, h: bitmap.height }
        : null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null; // a thumbnail is an enhancement; the capture still stages
  }
}

/** The hints a plugin result carries: size, duration and a measured thumbnail. */
export async function captureHints(result: MediaResult): Promise<CaptureHints> {
  const resolution = parseResolution(result.metadata?.resolution);
  const durationMs = secondsToMs(result.metadata?.duration);
  const thumbnail = result.thumbnail
    ? await decodeThumbnail(result.thumbnail)
    : null;
  // Without a decoded thumbnail there is nothing to tell whether `resolution` is sensor-
  // oriented, so the size is left out and the upload probe measures the file itself.
  const size =
    resolution && thumbnail ? orientToThumbnail(resolution, thumbnail) : null;
  return {
    ...(size ? { width: size.width, height: size.height } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(thumbnail ? { thumbnail } : {}),
  };
}

/**
 * Turn a plugin result into a staged-ready file. A declared size over `maxBytes` is refused
 * BEFORE the bytes are fetched into the WebView — a long video can be hundreds of MB.
 */
export async function toCapturedMedia(
  kind: CaptureKind,
  result: MediaResult,
  maxBytes: number | null,
): Promise<CapturedMedia> {
  const declared = result.metadata?.size;
  if (
    maxBytes !== null &&
    typeof declared === 'number' &&
    declared > maxBytes
  ) {
    throw new CaptureTooLargeError(declared, maxBytes);
  }
  const src =
    result.webPath ??
    (result.uri ? Capacitor.convertFileSrc(result.uri) : null);
  if (!src) {
    throw new Error('The camera returned no file.');
  }
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`The camera file could not be read (${response.status}).`);
  }
  const blob = await response.blob();
  if (maxBytes !== null && blob.size > maxBytes) {
    throw new CaptureTooLargeError(blob.size, maxBytes);
  }
  const { extension, mimeType } = captureFormat(
    kind,
    result.metadata?.format,
    blob.type,
  );
  return {
    file: new File([blob], `${kind}.${extension}`, { type: mimeType }),
    hints: await captureHints(result),
  };
}
