import type { BuildInfo } from '@trinity/platform-native';
import {
  catchError,
  defaultIfEmpty,
  defer,
  of,
  take,
  throwIfEmpty,
  timeout,
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

/**
 * Names one source knows, usually one room's: its name and topic and its members' display
 * names. The app returns them all once, after the log is read; the export indexes those that
 * occur in the log while it builds the file. Never stored.
 */
export interface DiagnosticNameGroup {
  readonly roomNames: readonly string[];
  readonly roomTopics: readonly string[];
  readonly displayNames: Iterable<string>;
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

/** How long the export waits for the names before it reports them as not replaced. */
export const KNOWN_NAMES_TIMEOUT_MS = 10_000;

/**
 * The names to replace in the file, read once, or none when there is no source. Cold; never
 * errors: a source that fails, completes empty or exceeds the timeout gives groups that throw
 * when read, so the export notes the gap.
 */
export function readKnownNames(
  source: DiagnosticAccountSource | null,
): Observable<Iterable<DiagnosticNameGroup>> {
  if (!source) {
    return of([]);
  }
  return defer(() => source.knownNames()).pipe(
    timeout({ first: KNOWN_NAMES_TIMEOUT_MS }),
    take(1),
    throwIfEmpty(),
    catchError((error: unknown) =>
      of<Iterable<DiagnosticNameGroup>>({
        [Symbol.iterator]: () => {
          throw error;
        },
      }),
    ),
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
