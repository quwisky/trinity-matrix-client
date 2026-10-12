// @trinity/data-access/diagnostic-log — the on-device diagnostic log: capture, storage,
// redaction and export. Consumers go through DiagnosticLogService; nothing reads the store.
export * from './lib/diagnostic-entry.model';
export * from './lib/scrub-secrets';
export * from './lib/store/diagnostic-log-store';
export * from './lib/store/indexed-db-log-store';
export * from './lib/diagnostic-log-recorder';
export * from './lib/capture/format-log-args';
export * from './lib/capture/console-capture';
export * from './lib/platform-description';
export * from './lib/build-label';
export * from './lib/diagnostic-log.tokens';
export * from './lib/keep-diagnostic-log.preference';
export * from './lib/diagnostic-log.service';
export * from './lib/provide-diagnostic-log';
export * from './lib/redaction/redact-log';
