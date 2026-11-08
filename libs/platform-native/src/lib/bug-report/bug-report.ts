import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  catchError,
  defaultIfEmpty,
  defer,
  map,
  of,
  take,
  type Observable,
} from 'rxjs';
import { BUILD_INFO, type BuildInfo } from '../build-info';
import { describePlatform, readPlatformFacts } from './platform-description';

/** Where "Open bug report on GitHub" goes; null leaves the GitHub step out. */
export interface BugReportConfig {
  readonly issueRepositoryUrl: string | null;
}

export const BUG_REPORT_CONFIG = new InjectionToken<BugReportConfig>(
  'BUG_REPORT_CONFIG',
  { providedIn: 'root', factory: () => ({ issueRepositoryUrl: null }) },
);

/** One signed-in account as a bug report sees it: only what its server runs. */
export interface BugReportAccount {
  /** What the server says it runs, or null when it did not answer. */
  readonly software: { readonly name: string; readonly version: string } | null;
}

/** Supplies the signed-in accounts for a bug report; implemented by the app. */
export interface BugReportAccountSource {
  /** Active account first. Must complete. */
  accounts(): Observable<readonly BugReportAccount[]>;
}

export const BUG_REPORT_ACCOUNT_SOURCE =
  new InjectionToken<BugReportAccountSource>('BUG_REPORT_ACCOUNT_SOURCE');

/** What the GitHub form is pre-filled with. Never carries a server name. */
export interface BugReportFacts {
  readonly version: string;
  readonly platform: string;
  readonly homeservers: readonly string[];
}

/** `Trinity v0.4.0 · 261efbe9`, the shape the issue template's version field asks for. */
export function buildLabel(build: BuildInfo | null): string {
  return build?.version
    ? `Trinity v${build.version} · ${build.commit || 'unknown'}`
    : 'Trinity (version unknown)';
}

/** The issue form's facts: the build, the platform and each server's software, never its name. */
export function bugReportFacts(
  build: BuildInfo | null,
  platform: string,
  accounts: readonly BugReportAccount[],
): BugReportFacts {
  const homeservers = accounts.flatMap(({ software }) =>
    software ? [`${software.name} ${software.version}`] : [],
  );
  return {
    version: buildLabel(build),
    platform,
    homeservers: [...new Set(homeservers)],
  };
}

/** Reads the facts a bug report pre-fills on GitHub. */
@Injectable({ providedIn: 'root' })
export class BugReportFactsService {
  private readonly build = inject(BUILD_INFO, { optional: true });
  private readonly source = inject(BUG_REPORT_ACCOUNT_SOURCE, {
    optional: true,
  });

  /**
   * The build, this platform and each signed-in homeserver's software. Cold; never errors:
   * an account source that fails or completes empty leaves the homeservers out.
   */
  facts(): Observable<BugReportFacts> {
    return defer(() => {
      const platform = describePlatform(readPlatformFacts());
      return defer(
        () => this.source?.accounts() ?? of<readonly BugReportAccount[]>([]),
      ).pipe(
        take(1),
        defaultIfEmpty([] as readonly BugReportAccount[]),
        catchError(() => of<readonly BugReportAccount[]>([])),
        map((accounts) => bugReportFacts(this.build, platform, accounts)),
      );
    });
  }
}
