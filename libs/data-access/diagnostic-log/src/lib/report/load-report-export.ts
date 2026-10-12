/** The export code: the bundle builder, the redactor and the issue URL builder. */
export type ReportExportModule = typeof import('./report-export');

/** Builds the pre-filled GitHub issue URL; null when it can't be built. */
export type BugReportUrlBuilder = ReportExportModule['buildBugReportUrl'];

/** Load the export code, in its own chunk outside the initial bundle. */
export function loadReportExport(): Promise<ReportExportModule> {
  return import('./report-export');
}

/**
 * Load the issue URL builder. The report dialog loads it when it opens, so opening GitHub
 * stays synchronous in the click that asks for it (a browser blocks a later window open).
 */
export function loadBugReportUrlBuilder(): Promise<BugReportUrlBuilder> {
  return loadReportExport().then((module) => module.buildBugReportUrl);
}
