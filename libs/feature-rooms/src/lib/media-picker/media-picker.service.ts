import { Injectable } from '@angular/core';
import { Observable, defer, from, of, switchMap } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { Camera, type MediaResult } from '@capacitor/camera';

/**
 * Picks a media file for the composer. On a native platform it opens the
 * Capacitor gallery picker and materializes the choice into a `File`; on the web
 * it is a no-op ({@link available} === false) and the composer falls back to a
 * hidden `<input type="file">` — which itself surfaces the native picker/camera
 * when running inside a Capacitor WebView.
 */
@Injectable({ providedIn: 'root' })
export class MediaPickerService {
  /** True when the native gallery picker should be used instead of `<input>`. */
  readonly available = Capacitor.isNativePlatform();

  /** Open the native gallery and resolve the chosen image as a File, or null. */
  pickImage(): Observable<File | null> {
    if (!this.available) {
      return of(null);
    }
    return defer(() =>
      from(Camera.chooseFromGallery({ allowMultipleSelection: false })),
    ).pipe(switchMap((res) => from(toFile(res.results[0]))));
  }
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
