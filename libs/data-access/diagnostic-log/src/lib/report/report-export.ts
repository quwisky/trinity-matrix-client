// Loaded on demand by `loadReportExport()`: the bundle builder, the redactor and the issue
// URL builder stay out of the initial bundle. Capture (scrubbing, recorder, store) does not
// live here: it runs from startup.
export { buildDiagnosticBundleInSlices } from '../diagnostic-bundle';
export { buildBugReportUrl } from '../bug-report-url';
