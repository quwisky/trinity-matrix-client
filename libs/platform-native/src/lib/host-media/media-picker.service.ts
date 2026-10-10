import { Injectable } from '@angular/core';
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

/**
 * Host adapter that picks and captures media for the composer. On a native platform it opens the
 * Capacitor gallery picker and materializes the choice into a `File`; on the web
 * it is a no-op ({@link available} === false) and the composer falls back to a
 * hidden `<input type="file">` — which itself surfaces the native picker/camera
 * when running inside a Capacitor WebView.
 */
@Injectable({ providedIn: 'root' })
export class MediaPickerService {
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
   * Open the native gallery and resolve every chosen image as a File — empty when the user
   * picks nothing or dismisses. Gates on photo-library permission first, swallows a
   * user-cancel (resolves empty), and surfaces a denial as a
   * {@link GalleryPermissionDeniedError} — so the composer shows feedback instead of an
   * unhandled rejection.
   *
   * Materializing runs in parallel, unlike the SEND: each is a local `fetch` of a
   * `file://`/blob URL the WebView already holds, with none of the ordering, memory or
   * scheduler constraints that make uploads sequential.
   */
  pickImages(): Observable<File[]> {
    if (!this.available) {
      return of([]);
    }
    return defer(() => from(this.ensurePhotoAccess())).pipe(
      switchMap(() =>
        from(Camera.chooseFromGallery({ allowMultipleSelection: true })),
      ),
      switchMap((res) =>
        from(
          // `allSettled`, not `all`: one photo whose `webPath` will not fetch must cost you
          // that photo, not the other nine — the same principle the batch send commits to.
          Promise.allSettled(res.results.map((result) => toFile(result))).then(
            (settled) =>
              settled
                .map((entry) =>
                  entry.status === 'fulfilled' ? entry.value : null,
                )
                .filter((file): file is File => file !== null),
          ),
        ),
      ),
      catchError((err: unknown) => {
        // Dismissing the picker is a user choice, not a failure → null, no error.
        if (errorCode(err) === CameraErrorCode.ChooseMediaCancelled) {
          return of([]);
        }
        // A denial raised at pick time (rather than the gate) normalizes to the
        // same typed error, so there's a single clear message to show.
        if (errorCode(err) === CameraErrorCode.GalleryPermissionDenied) {
          return throwError(() => new GalleryPermissionDeniedError());
        }
        return throwError(() => err);
      }),
    );
  }

  /**
   * Gate on camera access, open the camera, and materialize the result. Cancelling is a
   * choice (null); a denial, a missing camera and an over-limit capture are typed errors the
   * composer turns into a notice or a toast.
   */
  private capture(
    kind: CaptureKind,
    options: CaptureOptions,
    open: () => Promise<MediaResult>,
  ): Observable<CapturedMedia | null> {
    if (!this.captureSupported) {
      return of(null);
    }
    return defer(() => from(this.ensureCameraAccess())).pipe(
      switchMap(() => from(open())),
      switchMap((result) =>
        from(toCapturedMedia(kind, result, options.maxBytes ?? null)),
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

/** Materialize a gallery result into a File via its web-accessible URL. */
async function toFile(result: MediaResult | undefined): Promise<File | null> {
  if (!result) {
    return null;
  }
  // `webPath` on web; on native the file:// `uri` must be mapped to a URL the
  // WebView can fetch.
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
