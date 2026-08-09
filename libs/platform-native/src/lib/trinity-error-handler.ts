import { ErrorHandler, Injectable } from '@angular/core';
import { isTransientMatrixError } from '@trinity/util/matrix';

/**
 * App-wide {@link ErrorHandler} that quiets transient homeserver noise.
 *
 * matrix-js-sdk fires bursts of concurrent requests during initial sync (thread
 * aggregation, `/relations`, `/event`, media thumbnails); a flaky/overloaded
 * homeserver answers some with 503s or dropped connections. The SDK's internal
 * rejections reach here and, under the default handler, spam the console as `ERROR`
 * — looking like an app crash.
 *
 * That they reach here at all depends on `provideBrowserGlobalErrorListeners()` in
 * `main.ts`: this app is zoneless, and without zone.js nothing else forwards a
 * `window` `unhandledrejection` to an `ErrorHandler`. Those listeners pass the raw
 * `PromiseRejectionEvent.reason`, so there is no envelope to unwrap — the
 * `{ rejection, promise }` shape this used to unpick was zone.js's alone.
 *
 * Transient failures ({@link isTransientMatrixError}) are logged quietly and
 * swallowed; everything else is delegated to the default handler untouched, so
 * genuine errors still surface.
 */
@Injectable()
export class TrinityErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    if (isTransientMatrixError(error)) {
      console.debug('[trinity] transient homeserver error (ignored):', error);
      return;
    }
    super.handleError(error);
  }
}
