// Loaded on demand by `loadReportExport()`, keeping the bundle builder and the redactor out of
// the initial bundle. Capture and scrubbing stay out of this chunk: they run from startup.
export { buildDiagnosticBundleInSlices } from '../diagnostic-bundle';
