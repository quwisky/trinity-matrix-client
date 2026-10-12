import type { BuildInfo } from '@trinity/platform-native';
import type { DiagnosticEntry } from './diagnostic-entry.model';
import { createLogRedactor, type LogRedactor } from './redaction/redact-log';
import {
  diagnosticLogFileName,
  diagnosticReportFacts,
  softwareLabel,
  type DiagnosticAccount,
  type DiagnosticReportFacts,
} from './report-facts';
import type { DiagnosticSnapshot } from './store/diagnostic-log-store';

/** The redacted file plus what the report flow needs alongside it. */
export interface DiagnosticBundle {
  readonly filename: string;
  readonly text: string;
  readonly entryCount: number;
  readonly facts: DiagnosticReportFacts;
}

export interface DiagnosticBundleInput {
  readonly now: Date;
  readonly build: BuildInfo | null;
  readonly platform: string;
  /** Active account first. */
  readonly accounts: readonly DiagnosticAccount[];
  readonly snapshot: DiagnosticSnapshot;
}

const PLACEHOLDER_NOTE =
  'Matrix IDs and server names are replaced with placeholders such as @user1:server1; tokens, keys and messages are never stored.';

/**
 * Build the exported file: `# ` header lines, then one redacted line per entry, oldest
 * first. Header and body share one redactor, so a placeholder means the same thing
 * throughout the file, and the preview shows exactly this text.
 */
export function buildDiagnosticBundle(
  input: DiagnosticBundleInput,
): DiagnosticBundle {
  const { accounts, snapshot } = input;
  const redactor = createLogRedactor({
    selfUserIds: accounts.map((account) => account.userId),
    selfDeviceIds: accounts.flatMap((account) =>
      account.deviceId ? [account.deviceId] : [],
    ),
    homeserverUrls: accounts.map((account) => account.homeserverUrl),
  });
  // Learn every identifier and server in the file before writing a line, so a bare server
  // name is replaced even where it appears before the first ID or URL that names it.
  redactor.learn(snapshot.entries.map(entryText).join('\n'));
  const facts = diagnosticReportFacts(input.build, input.platform, accounts);
  const dependencies = input.build?.dependencies;
  const header = [
    'Trinity diagnostic log',
    facts.version,
    `Platform: ${facts.platform}`,
    `matrix-js-sdk ${dependencies?.matrixJsSdk ?? 'unknown'}, matrix-sdk-crypto-wasm ${dependencies?.cryptoWasm ?? 'unknown'}`,
    `Accounts signed in: ${accounts.length}`,
    ...accounts.map((account, index) =>
      redactor.redact(
        `Account ${index + 1}${index === 0 ? ' (active)' : ''}: ${account.userId} on ${account.homeserverUrl}, ${softwareLabel(account) ?? 'homeserver software unknown'}`,
      ),
    ),
    captureWindow(snapshot.entries),
    snapshot.storage === 'indexeddb'
      ? 'Storage: on this device (IndexedDB)'
      : 'Storage: in memory only; this device would not let Trinity keep logs, so earlier sessions are missing',
    snapshot.dropped
      ? 'Dropped entries: older entries were removed to stay within 5 MB and 48 hours'
      : 'Dropped entries: none',
    PLACEHOLDER_NOTE,
  ].map((line) => `# ${line}`);
  const body = snapshot.entries.map((entry) => formatEntry(entry, redactor));
  return {
    filename: diagnosticLogFileName(input.now),
    text: `${[...header, ...body].join('\n')}\n`,
    entryCount: snapshot.entries.length,
    facts,
  };
}

function entryText(entry: DiagnosticEntry): string {
  return `${entry.source}/${entry.logger} ${entry.message}`;
}

function formatEntry(entry: DiagnosticEntry, redactor: LogRedactor): string {
  const line = redactor.redact(entryText(entry)).replace(/\r?\n/g, '\\n');
  return `${new Date(entry.ts).toISOString()} ${entry.level.toUpperCase()} ${line}`;
}

function captureWindow(entries: readonly DiagnosticEntry[]): string {
  const first = entries.at(0);
  const last = entries.at(-1);
  if (!first || !last) {
    return 'Capture window: no entries';
  }
  return `Capture window: ${new Date(first.ts).toISOString()} to ${new Date(last.ts).toISOString()} (${entries.length} entries)`;
}
