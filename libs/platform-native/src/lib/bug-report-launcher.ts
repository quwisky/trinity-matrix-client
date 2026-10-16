import { InjectionToken } from '@angular/core';

/** Opens Report a bug wherever the app is, signed in or not. */
export interface BugReportLauncher {
  open(): void;
}

/**
 * Report a bug for surfaces that cannot import the Settings feature (sign-in, System status,
 * the desktop title bar). Declared in this shared tier because `feature/auth` may not import
 * `@trinity/data-access/diagnostic-log`. Application Runtime provides it; where it is absent,
 * callers leave their entry out.
 */
export const BUG_REPORT_LAUNCHER = new InjectionToken<BugReportLauncher>(
  'BUG_REPORT_LAUNCHER',
);
