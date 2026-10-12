import { InjectionToken } from '@angular/core';

/** Opens Report a bug wherever the app is, signed in or not. */
export interface BugReportLauncher {
  open(): void;
}

/**
 * Report a bug for surfaces that cannot import the Settings feature: the sign-in screen
 * (`feature/auth`) and System status (`application/runtime`). Declared in this shared tier
 * because both already depend on it, while `@trinity/data-access/diagnostic-log` belongs to
 * a capability `feature/auth` may not import. Application Runtime provides it with the dialog
 * the application host loads lazily; where it is absent, callers leave their entry out.
 */
export const BUG_REPORT_LAUNCHER = new InjectionToken<BugReportLauncher>(
  'BUG_REPORT_LAUNCHER',
);
