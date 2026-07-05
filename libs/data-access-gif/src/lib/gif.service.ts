import { Injectable, inject } from '@angular/core';
import { Observable, from, of, switchMap, throwError } from 'rxjs';
import { GifSettingsService } from './gif-settings.service';
import { buildGifRequestUrl, parseGifResults } from './gif-providers';
import type { GifResult } from './gif.model';

/** How many GIFs to fetch per request. */
const RESULT_LIMIT = 24;

/**
 * Searches the configured GIF provider (Tenor or Giphy) and downloads a chosen
 * GIF as a `File` for the media send path. Provider selection + the API key come
 * from {@link GifSettingsService}; the provider REST shapes are normalized in
 * `gif-providers.ts`. Follows the app convention of `fetch()` wrapped in RxJS
 * rather than Angular `HttpClient`. Callers should only reach these once
 * {@link GifSettingsService.configured} is true.
 */
@Injectable({ providedIn: 'root' })
export class GifService {
  private readonly settings = inject(GifSettingsService);

  /** Trending GIFs, for the empty-query state. */
  trending(): Observable<GifResult[]> {
    return this.request(null);
  }

  /** Search GIFs; a blank query falls back to {@link trending}. */
  search(query: string): Observable<GifResult[]> {
    return this.request(query.trim() || null);
  }

  /** Download a chosen GIF as an `image/gif` File ready for `sendMedia`. */
  download(gif: GifResult): Observable<File> {
    return from(fetch(gif.url)).pipe(
      switchMap((res) =>
        res.ok
          ? from(res.blob())
          : throwError(() => new Error(`GIF download failed (${res.status})`)),
      ),
      switchMap((blob) => of(toGifFile(blob, gif))),
    );
  }

  /**
   * Fetch a preview GIF's bytes and bind them as a `blob:` object URL. The app's
   * CSP forbids a remote `<img src>` (tracking-pixel guard), so previews — like
   * avatars and media — are fetched over `connect-src` and shown as blobs. The
   * caller owns the returned URL and must revoke it.
   */
  fetchPreview(url: string): Observable<string> {
    return from(fetch(url)).pipe(
      switchMap((res) =>
        res.ok
          ? from(res.blob())
          : throwError(() => new Error(`GIF preview failed (${res.status})`)),
      ),
      switchMap((blob) => of(URL.createObjectURL(blob))),
    );
  }

  private request(query: string | null): Observable<GifResult[]> {
    const apiKey = this.settings.apiKey().trim();
    if (!apiKey) {
      return of([]);
    }
    const url = buildGifRequestUrl(
      this.settings.provider(),
      query,
      apiKey,
      RESULT_LIMIT,
    );
    const provider = this.settings.provider();
    return from(fetch(url)).pipe(
      switchMap((res) =>
        res.ok
          ? from(res.json())
          : throwError(() => new Error(`GIF search failed (${res.status})`)),
      ),
      switchMap((body) => of(parseGifResults(provider, body))),
    );
  }
}

/** Wrap downloaded bytes in a named `image/gif` File (forces the type so the
 * media pipeline classifies it as an image regardless of the CDN's headers). */
function toGifFile(blob: Blob, gif: GifResult): File {
  return new File([blob], filenameFor(gif), { type: 'image/gif' });
}

/** A safe, human-ish filename from the GIF description (falls back to "gif"). */
function filenameFor(gif: GifResult): string {
  const slug = gif.description
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'gif'}.gif`;
}
