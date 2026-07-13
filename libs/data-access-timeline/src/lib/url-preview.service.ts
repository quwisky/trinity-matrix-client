import { Injectable, inject, signal } from '@angular/core';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  of,
  shareReplay,
  tap,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

/** Open-Graph link preview for a URL, projected for the preview card. */
export interface UrlPreview {
  url: string;
  title: string | null;
  description: string | null;
  /** `mxc://` of the preview image (resolve for display), or null. */
  imageMxc: string | null;
}

/**
 * Fetches homeserver-proxied link previews (`getUrlPreview`) for URLs in messages, one
 * result cached (and shared) per URL. Callers gate on the room being unencrypted and on
 * the user's link-preview preference before asking, so a preview is only ever fetched for
 * a link the homeserver could already see. A failed / preview-disabled request resolves to
 * null so the card simply doesn't render.
 */
/** Cap on cached previews; distinct URLs across a session are otherwise unbounded. */
const CACHE_LIMIT = 256;

@Injectable({ providedIn: 'root' })
export class UrlPreviewService {
  private readonly matrix = inject(MatrixClientService);
  private readonly cache = new Map<string, Observable<UrlPreview | null>>();

  private readonly _supported = signal<boolean | null>(null);
  /**
   * Whether the homeserver provides link previews: `true` once its preview endpoint has
   * answered, `false` once it has reported the endpoint as missing/disabled, `null` until
   * the first attempt. Lets the UI hint that a homeserver simply doesn't do previews
   * (Synapse ships them off by default) rather than leaving the card silently absent.
   */
  readonly supported = this._supported.asReadonly();

  /** The link preview for `url`, or null when unavailable. Cached + shared per URL. */
  preview(url: string): Observable<UrlPreview | null> {
    const cached = this.cache.get(url);
    if (cached) {
      return cached;
    }
    this.evict();
    const request = defer(() => {
      if (!this.matrix.isInitialized) {
        return of(null);
      }
      return from(this.matrix.instance.getUrlPreview(url, Date.now())).pipe(
        tap(() => this._supported.set(true)), // the endpoint answered → previews work
        map((res) => toPreview(url, res)),
        catchError((err: unknown) => {
          // A missing/disabled preview endpoint (404 / M_UNRECOGNIZED) means the
          // homeserver doesn't do previews at all — record it so the UI can say so.
          // Other (transient / per-URL) errors leave `supported` untouched.
          if (isPreviewEndpointUnavailable(err)) {
            this._supported.set(false);
          }
          return of(null);
        }),
      );
    }).pipe(
      // Cache a resolved preview, but drop a null (transient failure / not-signed-in
      // / nothing to show) so a later view re-fetches — a one-off homeserver error
      // must not suppress the card for the rest of the session.
      tap((preview) => {
        if (preview) {
          this.cache.set(url, of(preview));
        } else {
          this.cache.delete(url);
        }
      }),
      shareReplay(1),
    );
    this.cache.set(url, request);
    return request;
  }

  /** Drop the oldest entries (FIFO) so the per-session cache stays bounded. */
  private evict(): void {
    while (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
  }
}

/** Project the OG response into a {@link UrlPreview}, or null when there's nothing to show. */
function toPreview(
  url: string,
  res: Record<string, string | number | undefined>,
): UrlPreview | null {
  const title = str(res['og:title']);
  const description = str(res['og:description']);
  const imageMxc = str(res['og:image']);
  if (!title && !description && !imageMxc) {
    return null;
  }
  return { url, title, description, imageMxc };
}

function str(value: string | number | undefined): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Whether an error means the homeserver has no URL-preview endpoint (disabled/unrecognised),
 * as opposed to a transient or per-URL failure. Keyed on the `M_UNRECOGNIZED` errcode (or a
 * bare 404) that Synapse returns for the endpoint when `url_preview_enabled` is off.
 */
function isPreviewEndpointUnavailable(err: unknown): boolean {
  const matrixError = err as { errcode?: unknown; httpStatus?: unknown } | null;
  return (
    matrixError?.errcode === 'M_UNRECOGNIZED' || matrixError?.httpStatus === 404
  );
}
