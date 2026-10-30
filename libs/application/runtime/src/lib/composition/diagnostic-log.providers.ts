import {
  inject,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import {
  DIAGNOSTIC_ACCOUNT_SOURCE,
  DIAGNOSTIC_REPORT_CONFIG,
  DIAGNOSTIC_SDK_CAPTURE,
  DiagnosticLogService,
  provideDiagnosticLog,
  type DiagnosticAccountSource,
} from '@trinity/data-access/diagnostic-log';
import { HomeserverInfoService } from '@trinity/data-access/homeserver';
import {
  MATRIX_SDK_LOG_SINK,
  SESSION_ENGINE,
  type MatrixSdkLogSink,
} from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import {
  diagnosticAccounts,
  diagnosticKnownNames,
} from './diagnostic-accounts';
import { matrixSdkCapture } from './diagnostic-sdk-capture';

export interface TrinityDiagnosticOptions {
  readonly issueRepositoryUrl: string | null;
}

/**
 * The on-device diagnostic log, the SDK sink that feeds it and the switch that detaches that
 * sink. Listed after `provideMatrixSdkLogging()`, which attaches the sink, so that a stored
 * "off" read by `DiagnosticLogService.start()` can detach it again.
 */
export function trinityDiagnosticProviders(
  options: TrinityDiagnosticOptions,
): readonly (Provider | EnvironmentProviders)[] {
  return [
    provideDiagnosticLog(),
    {
      provide: MATRIX_SDK_LOG_SINK,
      useFactory: (): MatrixSdkLogSink => {
        const log = inject(DiagnosticLogService);
        return {
          write: (record) => log.recordSdk(record),
          echo: (print) => log.withoutConsoleCapture(print),
        };
      },
    },
    { provide: DIAGNOSTIC_SDK_CAPTURE, useFactory: matrixSdkCapture },
    {
      provide: DIAGNOSTIC_ACCOUNT_SOURCE,
      useFactory: (): DiagnosticAccountSource => {
        const sessions = inject(SessionStorageService);
        const homeservers = inject(HomeserverInfoService);
        const engine = inject(SESSION_ENGINE);
        return {
          accounts: () => diagnosticAccounts(sessions, homeservers),
          knownNames: () => diagnosticKnownNames(engine),
        };
      },
    },
    {
      provide: DIAGNOSTIC_REPORT_CONFIG,
      useValue: { issueRepositoryUrl: options.issueRepositoryUrl },
    },
  ];
}
