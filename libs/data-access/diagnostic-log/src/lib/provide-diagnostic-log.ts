import {
  inject,
  provideEnvironmentInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import { DiagnosticLogService } from './diagnostic-log.service';

/**
 * Start the diagnostic log when the root injector is created, before any Matrix client.
 * List it after `provideMatrixSdkLogging()`: that call attaches the SDK sink, and a stored
 * "off" must be able to detach it again, through `DIAGNOSTIC_SDK_CAPTURE`, once read.
 */
export function provideDiagnosticLog(): EnvironmentProviders {
  return provideEnvironmentInitializer(() =>
    inject(DiagnosticLogService).start(),
  );
}
