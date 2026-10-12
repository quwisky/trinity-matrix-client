// Loaded on demand by `loadReportExport()`: the bundle builder and the redactor stay out of
// the initial bundle. Capture (scrubbing, recorder, store) does not live here: it runs from
// startup. The issue URL builder is eager, so GitHub works even if this chunk can't load.
export { buildDiagnosticBundleInSlices } from '../diagnostic-bundle';
