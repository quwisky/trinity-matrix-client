import { Injectable, inject } from '@angular/core';
import {
  Observable,
  catchError,
  defer,
  from,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { HostSystemUiService } from '@trinity/runtime/host';
import { Filesystem } from '@capacitor/filesystem';
import {
  Camera,
  CameraErrorCode,
  type MediaResult,
  type PermissionStatus,
} from '@capacitor/camera';
import {
  CapturePermissionDeniedError,
  NoCameraError,
  toCapturedMedia,
  type CaptureKind,
  type CaptureOptions,
  type CapturedMedia,
} from './captured-media';

/**
 * Raised by {@link MediaPickerService.pickImages} when photo-library access is denied.
 * Carries a user-facing message so the composer can surface it verbatim.
 */
class GalleryPermissionDeniedError extends Error {
  constructor() {
    super('Photo access is denied. Enable it in Settings to attach images.');
    this.name = 'GalleryPermissionDeniedError';
  }
}

/** What {@link MediaPickerService.pickImages} resolved: the photos it read, and how many it skipped. */
export interface PickedImages {
  readonly files: File[];
  /** Photos whose reported size was over `maxBytes`; their bytes were never read. */
  readonly oversized: number;
}

/**
 * Host adapter that picks and captures media for the composer. On the web it is a no-op
 * ({@link available} === false) and the composer falls back to a hidden `<input type="file">`.
 */
@Injectable({ providedIn: 'root' })
export class MediaPickerService {
  private readonly systemUi = inject(HostSystemUiService);

  /** True when the native gallery picker should be used instead of `<input>`. */
  readonly available = Capacitor.isNativePlatform();

  /** True where the camera plugin can take photos and record video (iOS, Android). */
  readonly captureSupported = Capacitor.isNativePlatform();

  /** Open the camera for a photo; null when the user cancels. */
  capturePhoto(options: CaptureOptions): Observable<CapturedMedia | null> {
    return this.capture('photo', options, () =>
      Camera.takePhoto({
        includeMetadata: true,
        correctOrientation: true,
        saveToGallery: options.saveToGallery,
      }),
    );
  }

  /** Open the camera for a video; null when the user cancels. */
  captureVideo(options: CaptureOptions): Observable<CapturedMedia | null> {
    return this.capture('video', options, () =>
      Camera.recordVideo({
        includeMetadata: true,
        saveToGallery: options.saveToGallery,
      }),
    );
  }

  /**
   * Open the native gallery and resolve every chosen image as a File; empty when the user
   * dismisses. A denial surfaces as {@link GalleryPermissionDeniedError}.
   *
   * A photo over `maxBytes` on disk is skipped before its bytes are fetched into the WebView
   * and counted in {@link PickedImages.oversized}. The size is a filesystem `stat`, not the
   * plugin's `includeMetadata`, which decodes every photo in full to build its EXIF. If the
   * size cannot be read the photo is fetched anyway, and the caller's own size check on the
   * file still applies. `maxBytes` is awaited only after the user has chosen, so a slow
   * lookup never delays the picker.
   *
   * Materializing runs in parallel, unlike the send: each is a local fetch of a URL the
   * WebView already holds.
   */
  pickImages(
    maxBytes?: number | null | PromiseLike<number | null>,
  ): Observable<PickedImages> {
    if (!this.available) {
      return of({ files: [], oversized: 0 });
    }
    // The photo picker is Trinity's own system UI: App lock's away timer ignores it.
    return this.systemUi.track(
      defer(() => from(this.ensurePhotoAccess())).pipe(
        switchMap(() =>
          from(
            Camera.chooseFromGallery({
              allowMultipleSelection: true,
            }),
          ),
        ),
        switchMap((res) =>
          from(
            Promise.resolve(maxBytes ?? null).then((limit) =>
              materialize(res.results, limit),
            ),
          ),
        ),
        catchError((err: unknown) => {
          // Dismissing the picker is a user choice, not a failure.
          if (errorCode(err) === CameraErrorCode.ChooseMediaCancelled) {
            return of({ files: [], oversized: 0 });
          }
          // A denial raised at pick time normalizes to the same typed error as the gate.
          if (errorCode(err) === CameraErrorCode.GalleryPermissionDenied) {
            return throwError(() => new GalleryPermissionDeniedError());
          }
          return throwError(() => err);
        }),
      ),
    );
  }

  /**
   * Gate on camera access, open the camera, and materialize the result. Cancelling gives
   * null; a denial, a missing camera and an over-limit capture are typed errors.
   */
  private capture(
    kind: CaptureKind,
    options: CaptureOptions,
    open: () => Promise<MediaResult>,
  ): Observable<CapturedMedia | null> {
    if (!this.captureSupported) {
      return of(null);
    }
    // The camera is Trinity's own system UI: App lock's away timer ignores it.
    return this.systemUi.track(
      defer(() => from(this.ensureCameraAccess())).pipe(
        switchMap(() => from(open())),
        switchMap((result) =>
          from(
            // Awaited only now: a cancel rejects `open()` above and never reaches this.
            Promise.resolve(options.maxBytes ?? null).then((maxBytes) =>
              toCapturedMedia(kind, result, maxBytes),
            ),
          ),
        ),
        catchError((err: unknown): Observable<CapturedMedia | null> => {
          const code = errorCode(err);
          if (
            code === CameraErrorCode.TakePhotoCancelled ||
            code === CameraErrorCode.RecordVideoCancelled
          ) {
            return of(null);
          }
          if (code === CameraErrorCode.CameraPermissionDenied) {
            return throwError(() => new CapturePermissionDeniedError('camera'));
          }
          if (code === CameraErrorCode.GalleryPermissionDenied) {
            return throwError(() => new CapturePermissionDeniedError('photos'));
          }
          if (code === CameraErrorCode.NoCameraAvailable) {
            return throwError(() => new NoCameraError());
          }
          return throwError(() => err);
        }),
      ),
    );
  }

  /** Resolve once camera access is granted; reject with a typed error if denied. */
  private async ensureCameraAccess(): Promise<void> {
    let status: PermissionStatus = await Camera.checkPermissions();
    if (
      status.camera === 'prompt' ||
      status.camera === 'prompt-with-rationale'
    ) {
      status = await Camera.requestPermissions({ permissions: ['camera'] });
    }
    if (status.camera !== 'granted') {
      throw new CapturePermissionDeniedError('camera');
    }
  }

  /** Resolve once photo-library access is granted; reject with a typed error if denied. */
  private async ensurePhotoAccess(): Promise<void> {
    let status: PermissionStatus = await Camera.checkPermissions();
    if (
      status.photos === 'prompt' ||
      status.photos === 'prompt-with-rationale'
    ) {
      status = await Camera.requestPermissions({ permissions: ['photos'] });
    }
    // 'limited' (iOS partial library) is enough to pick; only outright denial blocks.
    if (status.photos !== 'granted' && status.photos !== 'limited') {
      throw new GalleryPermissionDeniedError();
    }
  }
}

/** The `code` on a Capacitor plugin rejection, if present. */
function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  return undefined;
}

/**
 * Read every result within `maxBytes` into a File and count the ones over it, unread.
 * `allSettled`, not `all`: one photo whose `webPath` will not fetch must not cost the rest.
 */
async function materialize(
  results: readonly MediaResult[],
  maxBytes: number | null,
): Promise<PickedImages> {
  const sizes =
    maxBytes === null
      ? []
      : await Promise.all(results.map((result) => sizeOnDisk(result)));
  const readable = results.filter((_, i) => {
    const size = sizes[i];
    return size === undefined || maxBytes === null || size <= maxBytes;
  });
  const settled = await Promise.allSettled(readable.map((r) => toFile(r)));
  return {
    files: settled
      .map((entry) => (entry.status === 'fulfilled' ? entry.value : null))
      .filter((file): file is File => file !== null),
    oversized: results.length - readable.length,
  };
}

/**
 * A picked file's size in bytes from the filesystem, without reading it; undefined when it
 * cannot be told (no `uri`, a failed stat, or a size that is not a positive number).
 */
async function sizeOnDisk(result: MediaResult): Promise<number | undefined> {
  if (!result.uri) {
    return undefined;
  }
  try {
    const { size } = await Filesystem.stat({ path: result.uri });
    return Number.isFinite(size) && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

/** Materialize a gallery result into a File via its web-accessible URL. */
async function toFile(result: MediaResult | undefined): Promise<File | null> {
  if (!result) {
    return null;
  }
  // On native the file:// `uri` must be mapped to a URL the WebView can fetch.
  const src =
    result.webPath ??
    (result.uri ? Capacitor.convertFileSrc(result.uri) : null);
  if (!src) {
    return null;
  }
  const response = await fetch(src);
  // An error status resolves rather than rejects; throwing drops this photo like a failed fetch.
  if (!response.ok) {
    throw new Error(`The picked photo could not be read (${response.status}).`);
  }
  const blob = await response.blob();
  const type = blob.type || 'image/jpeg';
  const ext = type.split('/')[1]?.split('+')[0] || 'jpg';
  return new File([blob], `image.${ext}`, { type });
}
