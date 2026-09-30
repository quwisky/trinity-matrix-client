import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PIXEL_5_ACCOUNT_PROFILE } from './account-workspace-client.mts';
import {
  QUOTE_NOTIFICATION_ASSERTION_RECORDS,
  QUOTE_NOTIFICATION_STAGES,
  type QuoteNotificationStageId,
} from './quote-notification-contract.mts';
import {
  scanPinnedPanelArtifacts,
  type PinnedPanelPublicationSafety,
} from './pinned-message-panel-artifacts.mts';

/*
 * Suite-specific publication safety for the installed-Android
 * quote-notification suite. Scrub, scan,
 * redaction, the encoded-pattern builder and the guarded cleanup runner are
 * #756's stage-free helpers, imported and used unchanged by the journeys;
 * only the secrets, marker and abort-revocation stay local here,
 * because they are the only pieces that need this suite's one-stage shape.
 */

const PASSED_CAPTURES = ['passed.json', 'passed-ui.json', 'passed-surface.json'] as const;
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export type QuoteNotificationPublicationSafety = PinnedPanelPublicationSafety;

/** Every identifier the stage creates: the writer and the reader, and one Room. */
export interface QuoteNotificationSecretIds {
  readonly accounts: readonly {
    readonly userId: string;
    readonly username: string;
    readonly password: string;
  }[];
  readonly rooms: readonly { readonly id?: string; readonly name?: string }[];
  /** Run-scoped texts: the answer, the probe and the reader sync token (never the fixed source body). */
  readonly texts: readonly string[];
  readonly eventIds: readonly string[];
  /** Each transaction id is derived from the run, not one of the texts; registered under its own key. */
  readonly transactions: readonly string[];
}

interface AbortReport {
  status: 'running' | 'passed' | 'failed';
  readonly stages: readonly {
    status: 'running' | 'passed' | 'failed';
    failureCount: number;
    error?: string;
  }[];
}

/**
 * Register every stage identifier in each form it can reach a diagnostic: raw,
 * `slice(1)`, component-encoded and the base64url Room route segment. Encoded
 * forms are values of their own, so their patterns also cover `%25xx` nesting.
 */
export function quoteNotificationSecrets(
  stage: QuoteNotificationStageId,
  ids: QuoteNotificationSecretIds,
): Record<string, string> {
  assert(QUOTE_NOTIFICATION_STAGES.some((entry) => entry.id === stage),
    'Quote-notification secrets belong to a contract stage');
  const prefix = `SECRET_QUOTE_NOTIFICATION_${stage.toUpperCase().replaceAll('-', '_')}`;
  const values: Record<string, string> = {};
  const add = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    assert(typeof value === 'string' && value.length > 0,
      'Quote-notification secret values are non-empty strings');
    values[`${prefix}_${key}`] = value;
  };
  const addEncoded = (key: string, value: string | undefined): void => {
    add(key, value);
    if (value !== undefined && encodeURIComponent(value) !== value)
      add(`${key}_ENCODED`, encodeURIComponent(value));
  };
  ids.accounts.forEach((account, index) => {
    const n = index + 1;
    addEncoded(`ACCOUNT_${n}_USER_ID`, account.userId);
    add(`ACCOUNT_${n}_USERNAME`, account.username);
    add(`ACCOUNT_${n}_PASSWORD`, account.password);
  });
  ids.rooms.forEach((room, index) => {
    const n = index + 1;
    if (room.id !== undefined) {
      addEncoded(`ROOM_${n}_ID`, room.id);
      addEncoded(`ROOM_${n}_ID_SLICE`, room.id.slice(1));
      add(`ROOM_${n}_ID_B64URL`, Buffer.from(room.id).toString('base64url'));
    }
    add(`ROOM_${n}_NAME`, room.name);
  });
  ids.texts.forEach((text, index) => addEncoded(`TEXT_${index + 1}`, text));
  ids.eventIds.forEach((eventId, index) => addEncoded(`EVENT_${index + 1}_ID`, eventId));
  ids.transactions.forEach((txn, index) => addEncoded(`TRANSACTION_${index + 1}`, txn));
  for (const value of Object.values(values))
    assert(value !== 'localhost', 'The bare server name is never a quote-notification secret');
  return values;
}

async function requireTextFile(path: string): Promise<void> {
  const metadata = await stat(path);
  assert(metadata.isFile() && metadata.size > 0,
    'Required quote-notification text capture or provenance exists');
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  await requireTextFile(path);
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(typeof value === 'object' && value !== null && !Array.isArray(value),
    'Quote-notification diagnostic JSON is an object');
  return value as Record<string, unknown>;
}

function assertPassedReport(report: Record<string, unknown>): void {
  assert(report['status'] === 'passed' &&
    report['expectedStages'] === QUOTE_NOTIFICATION_STAGES.length &&
    report['expectedAssertionRecords'] === QUOTE_NOTIFICATION_ASSERTION_RECORDS &&
    report['attempt'] === 1 && report['retries'] === 0,
  'Quote-notification report has every successful unretried stage');
  assert(Array.isArray(report['stages']) &&
    report['stages'].length === QUOTE_NOTIFICATION_STAGES.length,
  'Quote-notification report has exactly the contract stages');
  const identities = new Set<unknown>();
  QUOTE_NOTIFICATION_STAGES.forEach((entry, index) => {
    const stage = (report['stages'] as unknown[])[index] as Record<string, unknown>;
    assert(typeof stage === 'object' && stage !== null,
      'Quote-notification stage report is an object');
    assert(stage['id'] === entry.id && stage['status'] === 'passed' &&
      stage['attempt'] === 1 && stage['retries'] === 0 &&
      stage['expectedAssertionRecords'] === entry.expectedAssertionRecords &&
      stage['assertionRecords'] === entry.assertions.length &&
      stage['failureCount'] === 0,
    `Quote-notification stage ${index + 1} is ${entry.id} with every record passed`);
    assert.deepEqual(stage['assertions'], [...entry.assertions],
      `Quote-notification ${entry.id} parity identities are complete and source ordered`);
    for (const identity of entry.assertions) identities.add(identity);
  });
  assert.equal(identities.size, QUOTE_NOTIFICATION_ASSERTION_RECORDS,
    'Quote-notification parity identities are unique across stages');
}

/** Only a complete, captured, cleaned one-stage run may receive the hosted upload marker. */
export async function markQuoteNotificationDiagnosticsSafe(
  output: string,
  secrets: Readonly<Record<string, string>>,
  flags: Readonly<QuoteNotificationPublicationSafety>,
  signal: AbortSignal | undefined,
  report: object,
): Promise<void> {
  const marker = join(output, 'publication-safe');
  try {
    signal?.throwIfAborted();
    assert(!flags.unsafeSecrets && !flags.cleanupFailed && !flags.scrubFailed,
      'Incomplete secrets, cleanup or scrub blocks quote-notification publication');
    const current = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    assertPassedReport(current);
    assert.deepEqual(await readJsonObject(join(output, 'journeys.json')), current,
      'Persisted quote-notification report matches the run');
    const provenance = await readJsonObject(join(output, 'runtime-provenance.json'));
    const installed = provenance['profile'] as Record<string, unknown> | undefined;
    assert(provenance['schemaVersion'] === 1 && typeof installed === 'object' && installed !== null,
      'Quote-notification runtime provenance records its profile');
    assert.deepEqual(installed, {
      requested: PIXEL_5_ACCOUNT_PROFILE,
      digest: digest(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
    }, 'Quote-notification runtime provenance used the Pixel 5 profile');
    for (const entry of QUOTE_NOTIFICATION_STAGES) {
      const applied = await readJsonObject(join(output, entry.id, 'profile-applied.json'));
      assert.deepEqual(applied['requested'], PIXEL_5_ACCOUNT_PROFILE,
        `Quote-notification ${entry.id} applied the Pixel 5 profile`);
      for (const name of PASSED_CAPTURES)
        await requireTextFile(join(output, entry.id, name));
    }
    await scanPinnedPanelArtifacts(output, secrets);
    signal?.throwIfAborted();
    await writeFile(marker, 'scanned\n', { signal });
    signal?.throwIfAborted();
  } catch (error) {
    await rm(marker, { force: true });
    throw error;
  }
}

/** A late abort must not retain a success report or publication marker. */
export async function revokeQuoteNotificationPublicationOnAbort(
  output: string,
  report: AbortReport,
  signal: AbortSignal,
): Promise<void> {
  if (!signal.aborted) return;
  await rm(join(output, 'publication-safe'), { force: true });
  report.status = 'failed';
  const stage = report.stages.at(-1);
  if (stage && stage.status !== 'failed') {
    stage.status = 'failed';
    stage.failureCount++;
  }
  if (stage) stage.error = 'Cancelled before quote-notification publication';
  await writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
}
