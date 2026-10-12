// @trinity/data-access/diagnostic-log — the on-device diagnostic log: capture, storage,
// redaction and export. Consumers go through DiagnosticLogService; nothing reads the store.
// Capture, scrubbing, redaction and the IndexedDB store stay internal to the library.
export {
  DiagnosticLogNotDeletedError,
  DiagnosticLogService,
  type DiagnosticAvailability,
  type DiagnosticRecord,
  type DiagnosticSdkCall,
} from './lib/diagnostic-log.service';
export * from './lib/diagnostic-log.tokens';
export { provideDiagnosticLog } from './lib/provide-diagnostic-log';
export type { DiagnosticBundle } from './lib/diagnostic-bundle';
export type { DiagnosticReportProgress } from './lib/report/prepare-report';
export {
  NO_KNOWN_NAMES,
  diagnosticLogFileName,
  type DiagnosticAccount,
  type DiagnosticKnownNames,
  type DiagnosticReportFacts,
} from './lib/report-facts';
// Eager (about 1 KB), so GitHub works with facts alone even when the export chunk fails.
export {
  GITHUB_ISSUE_URL_LIMIT,
  buildBugReportUrl,
  type BugReportDraft,
} from './lib/bug-report-url';
export type {
  DiagnosticEntry,
  DiagnosticLevel,
  DiagnosticSource,
} from './lib/diagnostic-entry.model';
// The store contract and its memory implementation, for specs that stand a memory store in
// for the database through DIAGNOSTIC_LOG_STORE_FACTORY.
export {
  MemoryLogStore,
  type DiagnosticLogStore,
} from './lib/store/diagnostic-log-store';
