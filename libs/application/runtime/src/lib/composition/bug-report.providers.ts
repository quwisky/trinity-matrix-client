import { inject, type Provider } from '@angular/core';
import { HomeserverInfoService } from '@trinity/data-access/homeserver';
import {
  BUG_REPORT_ACCOUNT_SOURCE,
  BUG_REPORT_CONFIG,
  SessionStorageService,
  type BugReportAccountSource,
} from '@trinity/platform-native';
import { bugReportAccounts } from './bug-report-accounts';

export interface TrinityBugReportOptions {
  readonly issueRepositoryUrl: string | null;
}

/** What Report a bug reads from the app: the repository to file in and the signed-in servers. */
export function trinityBugReportProviders(
  options: TrinityBugReportOptions,
): readonly Provider[] {
  return [
    {
      provide: BUG_REPORT_ACCOUNT_SOURCE,
      useFactory: (): BugReportAccountSource => {
        const sessions = inject(SessionStorageService);
        const homeservers = inject(HomeserverInfoService);
        return { accounts: () => bugReportAccounts(sessions, homeservers) };
      },
    },
    {
      provide: BUG_REPORT_CONFIG,
      useValue: { issueRepositoryUrl: options.issueRepositoryUrl },
    },
  ];
}
