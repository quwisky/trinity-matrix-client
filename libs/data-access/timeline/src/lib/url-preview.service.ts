import { Injectable, inject, signal } from '@angular/core';
import { Observable, defer, map, of, shareReplay, tap } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { CONVERSATION_CONTENT_ENGINE } from './conversation-content-engine.token';

/** Open-Graph link preview for a URL, projected for the preview card. */
export interface UrlPreview {
  url: string;
  title: string | null;
  description: string | null;
  /** `mxc://` of the preview image (resolve for display), or null. */
  imageMxc: string | null;
}

/** Cap on cached previews; distinct URLs across a session are otherwise unbounded. */
const CACHE_LIMIT = 256;

/**
 * Fetches homeserver-proxied link previews for URLs in messages, through the active account.
 * A result is cached (and shared) per URL, and per room as well for a room-gated preview.
 * Callers gate on the user's link-preview preference,
 * and without the encrypted-rooms opt-in ask through {@link previewIfUnencrypted}, so a
 * preview is only ever fetched for a link the homeserver could already see. A failed /
 * preview-disabled request resolves to null so the card simply doesn't render.
 */
@Injectable({ providedIn: 'root' })
export class UrlPreviewService {
  private readonly engine = inject(CONVERSATION_CONTENT_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly cache = new Map<string, Observable<UrlPreview | null>>();

  private readonly _supported = signal<boolean | null>(null);
  /**
   * Whether the homeserver provides link previews, as the latest telling answer from any
   * account says: `true` once an ungated request answers or a gated one returns a preview,
   * `false` once the endpoint is reported missing/disabled, `null` until either happens.
   * Lets the UI hint that a homeserver simply doesn't do previews (Synapse ships them off
   * by default) rather than leaving the card silently absent.
   */
  readonly supported = this._supported.asReadonly();

  /** The link preview for `url`, or null when unavailable. Cached + shared per URL. */
  preview(url: string): Observable<UrlPreview | null> {
    return this.cached(url, null);
  }

  /**
   * {@link preview}, once `roomId` is confirmed unencrypted: null without a request for a
   * room that is encrypted, missing, or whose crypto store cannot answer, since asking
   * would show the homeserver a URL from an encrypted message.
   */
  previewIfUnencrypted(
    url: string,
    roomId: string | null,
  ): Observable<UrlPreview | null> {
    // A null gate would mean "no check" to the engine, so a message without a room is refused here.
    return roomId === null ? of(null) : this.cached(url, roomId);
  }

  /** Cached per gate as well as URL: a preview cleared for one room says nothing of another. */
  private cached(
    url: string,
    onlyIfUnencrypted: string | null,
  ): Observable<UrlPreview | null> {
    const key =
      onlyIfUnencrypted === null ? url : `${onlyIfUnencrypted}\n${url}`;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    this.evict();
    const request = defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) {
        return of(null);
      }
      return this.engine
        .linkPreview(accountId, url, { onlyIfUnencrypted })
        .pipe(
          map((result) => {
            if (result.ok) {
              // A gated null may be a refusal that asked nothing, so only a preview proves
              // the endpoint answered there.
              if (result.value || onlyIfUnencrypted === null) {
                this._supported.set(true);
              }
              return result.value && { url, ...result.value };
            }
            // A missing/disabled endpoint means the homeserver doesn't do previews at all;
            // other (transient / per-URL) errors leave `supported` untouched.
            if (result.failure.code === 'unsupported') {
              this._supported.set(false);
            }
            return null;
          }),
        );
    }).pipe(
      // Cache a resolved preview, but drop a null (transient failure / not-signed-in
      // / nothing to show) so a later view re-fetches — a one-off homeserver error
      // must not suppress the card for the rest of the session.
      tap((preview) => {
        if (preview) {
          this.cache.set(key, of(preview));
        } else {
          this.cache.delete(key);
        }
      }),
      shareReplay(1),
    );
    this.cache.set(key, request);
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
