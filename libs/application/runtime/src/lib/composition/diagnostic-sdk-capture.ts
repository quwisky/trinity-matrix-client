import { Injector, inject } from '@angular/core';
import type { DiagnosticSdkCapture } from '@trinity/data-access/diagnostic-log';
import {
  MATRIX_SDK_LOG_SINK,
  configureMatrixSdkLogging,
  matrixSdkLogLevel,
} from '@trinity/data-access/matrix-client';

/**
 * `DIAGNOSTIC_SDK_CAPTURE` for Application Runtime. Enabled, every SDK logger runs at debug
 * and feeds the sink; disabled, the sink is detached and the loggers fall back to the
 * console level `provideMatrixSdkLogging()` set, so nothing is built at debug. Synchronous:
 * `DiagnosticLogService` calls it first thing when the log turns off, so there is no window
 * with SDK loggers at debug. The sink is looked up on use, because its factory injects
 * `DiagnosticLogService`, which injects this.
 */
export function matrixSdkCapture(): DiagnosticSdkCapture {
  const injector = inject(Injector);
  return {
    setEnabled: (enabled) =>
      configureMatrixSdkLogging(
        matrixSdkLogLevel(),
        enabled ? injector.get(MATRIX_SDK_LOG_SINK) : null,
      ),
  };
}
