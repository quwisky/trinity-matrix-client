import type { BuildInfo } from '@trinity/platform-native';
import {
  ReplaySubject,
  defer,
  forkJoin,
  map,
  merge,
  share,
  switchMap,
  type Observable,
} from 'rxjs';
import type {
  DiagnosticBundle,
  DiagnosticBundleInput,
} from '../diagnostic-bundle';
import {
  diagnosticReportFacts,
  type DiagnosticAccount,
  type DiagnosticNameGroup,
  type DiagnosticReportFacts,
} from '../report-facts';
import type { DiagnosticSnapshot } from '../store/diagnostic-log-store';

/** A report as it is prepared: the issue's facts as soon as they are known, then the file. */
export type DiagnosticReportProgress =
  | {
      readonly kind: 'facts';
      readonly facts: DiagnosticReportFacts;
      /** Whether any account is signed in on this device. */
      readonly signedIn: boolean;
    }
  | { readonly kind: 'bundle'; readonly bundle: DiagnosticBundle };

/** What a report is prepared from. */
export interface DiagnosticReportSources {
  readonly build: BuildInfo | null;
  readonly platform: () => string;
  /** The signed-in accounts: read once, complete, never error. */
  readonly accounts: Observable<readonly DiagnosticAccount[]>;
  /** The names to replace in the file: read once, after the snapshot; complete, never error. */
  readonly knownNames: Observable<Iterable<DiagnosticNameGroup>>;
  /** Everything stored plus the unflushed lines, once the setting is known. */
  readonly snapshot: Observable<DiagnosticSnapshot>;
  /** Builds the redacted file. */
  readonly bundle: (
    input: DiagnosticBundleInput,
  ) => Observable<DiagnosticBundle>;
}

/**
 * Prepare one bug report. The accounts, and with them each homeserver's software probe,
 * are read once and shared by the facts and the file. The facts come first, without
 * waiting for the setting or the store, so the issue can be filed while the log loads.
 * Cold; unsubscribing cancels whatever is still running.
 */
export function prepareDiagnosticReport(
  sources: DiagnosticReportSources,
): Observable<DiagnosticReportProgress> {
  return defer(() => {
    const platform = sources.platform();
    const accounts = sources.accounts.pipe(
      share({
        connector: () => new ReplaySubject<readonly DiagnosticAccount[]>(1),
        resetOnError: false,
        resetOnComplete: false,
        resetOnRefCountZero: true,
      }),
    );
    const facts = accounts.pipe(
      map((signedIn): DiagnosticReportProgress => ({
        kind: 'facts',
        facts: diagnosticReportFacts(sources.build, platform, signedIn),
        signedIn: signedIn.length > 0,
      })),
    );
    // The names are read after the snapshot, so a name learned meanwhile is still known.
    const bundle = forkJoin([sources.snapshot, accounts]).pipe(
      switchMap(([snapshot, signedIn]) =>
        sources.knownNames.pipe(
          switchMap((knownNames) =>
            sources.bundle({
              now: new Date(),
              build: sources.build,
              platform,
              accounts: signedIn,
              knownNames,
              snapshot,
            }),
          ),
        ),
      ),
      map((built): DiagnosticReportProgress => ({
        kind: 'bundle',
        bundle: built,
      })),
    );
    return merge(facts, bundle);
  });
}
