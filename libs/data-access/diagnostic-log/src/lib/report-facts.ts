import type { BuildInfo } from '@trinity/platform-native';
import {
  catchError,
  defaultIfEmpty,
  defer,
  of,
  take,
  type Observable,
} from 'rxjs';
import { buildLabel } from './build-label';
import type { DiagnosticAccountSource } from './diagnostic-log.tokens';

/** One signed-in account as the export sees it; never a token. */
export interface DiagnosticAccount {
  readonly userId: string;
  readonly deviceId: string | null;
  readonly homeserverUrl: string;
  /** What the server says it runs, or null when it did not answer. */
  readonly software: { readonly name: string; readonly version: string } | null;
}

/** What the GitHub form is pre-filled with. Never carries a server name. */
export interface DiagnosticReportFacts {
  readonly version: string;
  readonly platform: string;
  readonly homeservers: readonly string[];
}

/** The issue form's facts: the build, the platform and each server's software, never its name. */
export function diagnosticReportFacts(
  build: BuildInfo | null,
  platform: string,
  accounts: readonly DiagnosticAccount[],
): DiagnosticReportFacts {
  return {
    version: buildLabel(build),
    platform,
    homeservers: [
      ...new Set(
        accounts.flatMap((account) => {
          const label = softwareLabel(account);
          return label ? [label] : [];
        }),
      ),
    ],
  };
}

/** `Synapse 1.140.0`, or null when the server did not say what it runs. */
export function softwareLabel(account: DiagnosticAccount): string | null {
  return account.software
    ? `${account.software.name} ${account.software.version}`
    : null;
}

/** `trinity-<YYYY-MM-DD>.log` on the user's calendar, not UTC's. */
export function diagnosticLogFileName(now: Date): string {
  return `trinity-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`;
}

/**
 * The signed-in accounts, active first, read once: none when the app has no source, or when
 * it fails or completes empty. Never errors. Cold.
 */
export function readAccounts(
  source: DiagnosticAccountSource | null,
): Observable<readonly DiagnosticAccount[]> {
  return defer(
    () => source?.accounts() ?? of<readonly DiagnosticAccount[]>([]),
  ).pipe(
    take(1),
    defaultIfEmpty([] as readonly DiagnosticAccount[]),
    catchError(() => of<readonly DiagnosticAccount[]>([])),
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
