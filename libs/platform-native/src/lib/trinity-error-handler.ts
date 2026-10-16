import { ErrorHandler, Injectable } from '@angular/core';
import {
  isMatrixRequestAbortError,
  isTransientMatrixError,
  matrixRequestFailureDiagnostic,
} from '@trinity/util/matrix';

/**
 * App-wide {@link ErrorHandler} that quiets transient homeserver noise.
 *
 * matrix-js-sdk fires bursts of concurrent requests during initial sync, and a flaky
 * homeserver answers some with 503s or dropped connections; the SDK's rejections would
 * otherwise spam the console as `ERROR`. They reach here only because `main.ts` installs
 * `provideBrowserGlobalErrorListeners()`: the app is zoneless, so nothing else forwards
 * `unhandledrejection` to an `ErrorHandler`.
 *
 * Transient failures ({@link isTransientMatrixError}) are logged quietly and swallowed;
 * everything else goes to the default handler untouched.
 */
@Injectable()
export class TrinityErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    if (isTransientMatrixError(error) || isMatrixRequestAbortError(error)) {
      console.debug(
        '[trinity] transient homeserver error (ignored)',
        matrixRequestFailureDiagnostic('background Matrix request', error),
      );
      return;
    }
    super.handleError(error);
  }
}
