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

/**
 * Raised by {@link MediaPickerService.pickImages} when photo-library access is denied.
 * Carries a user-facing message so the composer can surface it verbatim.
 */
export class GalleryPermissionDeniedError extends Error {
  constructor() {
    super('Photo access is denied. Enable it in Settings to attach images.');
    this.name = 'GalleryPermissionDeniedError';
  }
}

/**
 * Host adapter that picks media for the composer. On a native platform it opens the
 * Capacitor gallery picker and materializes the choice into a `File`; on the web
 * it is a no-op ({@link available} === false) and the composer falls back to a
 * hidden `<input type="file">` — which itself surfaces the native picker/camera
 * when running inside a Capacitor WebView.
 */
@Injectable({ providedIn: 'root' })
export class MediaPickerService {
  /** True when the native gallery picker should be used instead of `<input>`. */
  readonly available = Capacitor.isNativePlatform();

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
  const blob = await fetch(src).then((r) => r.blob());
  const type = blob.type || 'image/jpeg';
  const ext = type.split('/')[1]?.split('+')[0] || 'jpg';
  return new File([blob], `image.${ext}`, { type });
}
