/** The export code: the bundle builder and the redactor. */
export type ReportExportModule = typeof import('./report-export');

/**
 * Load the export code, in its own chunk outside the initial bundle. Rejects when the chunk
 * can't be fetched (offline, or a stale chunk after a deploy); the report then has facts only.
 */
export function loadReportExport(): Promise<ReportExportModule> {
  return import('./report-export');
}
