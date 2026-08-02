import { ErrorHandler, Injectable } from '@angular/core';
import { isTransientMatrixError } from '@trinity/util/matrix';

/**
 * App-wide {@link ErrorHandler} that quiets transient homeserver noise.
 *
 * matrix-js-sdk fires bursts of concurrent requests during initial sync (thread
 * aggregation, `/relations`, `/event`, media thumbnails); a flaky/overloaded
 * homeserver answers some with 503s or dropped connections. The SDK's internal
 * rejections bubble up to Angular's global handler and, under the default handler,
 * spam the console as `ERROR` — looking like an app crash.
 *
 * Transient failures ({@link isTransientMatrixError}) are logged quietly and
 * swallowed; everything else is delegated to the default handler untouched, so
 * genuine errors still surface.
 */
@Injectable()
export class TrinityErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    // Angular wraps a rejected promise as `{ rejection, promise, ... }`; unwrap
    // so we inspect the real SDK error, not the Angular envelope.
    const e = (error as { rejection?: unknown })?.rejection ?? error;
    if (isTransientMatrixError(e)) {
      console.debug('[trinity] transient homeserver error (ignored):', e);
      return;
    }
    super.handleError(error);
  }
}
