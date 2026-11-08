// The on-device diagnostic log. Consumers go through DiagnosticLogService and nothing reads
// the store; capture, scrubbing and the IndexedDB store stay internal.
export {
  DiagnosticLogNotDeletedError,
  DiagnosticLogService,
  type DiagnosticAvailability,
  type DiagnosticRecord,
  type DiagnosticSdkCall,
} from './lib/diagnostic-log.service';
export * from './lib/diagnostic-log.tokens';
export { provideDiagnosticLog } from './lib/provide-diagnostic-log';
export type {
  DiagnosticAccount,
  DiagnosticReportFacts,
} from './lib/report-facts';
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
