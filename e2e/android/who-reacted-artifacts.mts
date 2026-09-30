import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GENERAL_TOUCH_PROFILE,
  WHO_REACTED_ASSERTION_RECORDS,
  WHO_REACTED_PROFILES,
  WHO_REACTED_STAGES,
  type WhoReactedStageId,
} from './who-reacted-contract.mts';
import {
  scanPinnedPanelArtifacts,
  type PinnedPanelPublicationSafety,
} from './pinned-message-panel-artifacts.mts';

/*
 * Suite-specific publication safety for the installed-Android
 * who-reacted suite. Scrub, scan,
 * redaction, the encoded-pattern builder and the guarded cleanup runner are
 * #756's stage-free helpers, imported and used unchanged by the journeys;
 * only the secrets, marker and abort-revocation stay local here,
 * because they are the only pieces that need this suite's two-stage shape.
 */

const PASSED_CAPTURES = ['passed.json', 'passed-ui.json', 'passed-surface.json'] as const;
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export type WhoReactedPublicationSafety = PinnedPanelPublicationSafety;

/** Every identifier the stage creates: the reader and 16 others, and one Room. */
export interface WhoReactedSecretIds {
  readonly accounts: readonly {
    readonly userId: string;
    readonly username: string;
    readonly password: string;
  }[];
  readonly rooms: readonly { readonly id?: string; readonly name?: string }[];
  /** Run-scoped texts: the body and the long display name. */
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
export function whoReactedSecrets(
  stage: WhoReactedStageId,
  ids: WhoReactedSecretIds,
): Record<string, string> {
  assert(WHO_REACTED_STAGES.some((entry) => entry.id === stage),
    'Who-reacted secrets belong to a contract stage');
  const prefix = `SECRET_WHO_REACTED_${stage.toUpperCase().replaceAll('-', '_')}`;
  const values: Record<string, string> = {};
  const add = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    assert(typeof value === 'string' && value.length > 0,
      'Who-reacted secret values are non-empty strings');
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
    assert(value !== 'localhost', 'The bare server name is never a who-reacted secret');
  return values;
}

async function requireTextFile(path: string): Promise<void> {
  const metadata = await stat(path);
  assert(metadata.isFile() && metadata.size > 0,
    'Required who-reacted text capture or provenance exists');
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  await requireTextFile(path);
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(typeof value === 'object' && value !== null && !Array.isArray(value),
    'Who-reacted diagnostic JSON is an object');
  return value as Record<string, unknown>;
}

function assertPassedReport(report: Record<string, unknown>): void {
  assert(report['status'] === 'passed' &&
    report['expectedStages'] === WHO_REACTED_STAGES.length &&
    report['expectedAssertionRecords'] === WHO_REACTED_ASSERTION_RECORDS &&
    report['attempt'] === 1 && report['retries'] === 0,
  'Who-reacted report has every successful unretried stage');
  assert(Array.isArray(report['stages']) &&
    report['stages'].length === WHO_REACTED_STAGES.length,
  'Who-reacted report has exactly the contract stages');
  const identities = new Set<unknown>();
  WHO_REACTED_STAGES.forEach((entry, index) => {
    const stage = (report['stages'] as unknown[])[index] as Record<string, unknown>;
    assert(typeof stage === 'object' && stage !== null,
      'Who-reacted stage report is an object');
    assert(stage['id'] === entry.id && stage['status'] === 'passed' &&
      stage['attempt'] === 1 && stage['retries'] === 0 &&
      stage['expectedAssertionRecords'] === entry.expectedAssertionRecords &&
      stage['assertionRecords'] === entry.assertions.length &&
      stage['failureCount'] === 0,
    `Who-reacted stage ${index + 1} is ${entry.id} with every record passed`);
    assert.deepEqual(stage['assertions'], [...entry.assertions],
      `Who-reacted ${entry.id} parity identities are complete and source ordered`);
    for (const identity of entry.assertions) identities.add(identity);
  });
  assert.equal(identities.size, WHO_REACTED_ASSERTION_RECORDS,
    'Who-reacted parity identities are unique across stages');
}

/** Only a complete, captured, cleaned two-stage run may receive the hosted upload marker. */
export async function markWhoReactedDiagnosticsSafe(
  output: string,
  secrets: Readonly<Record<string, string>>,
  flags: Readonly<WhoReactedPublicationSafety>,
  signal: AbortSignal | undefined,
  report: object,
): Promise<void> {
  const marker = join(output, 'publication-safe');
  try {
    signal?.throwIfAborted();
    assert(!flags.unsafeSecrets && !flags.cleanupFailed && !flags.scrubFailed,
      'Incomplete secrets, cleanup or scrub blocks who-reacted publication');
    const current = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    assertPassedReport(current);
    assert.deepEqual(await readJsonObject(join(output, 'journeys.json')), current,
      'Persisted who-reacted report matches the run');
    const provenance = await readJsonObject(join(output, 'runtime-provenance.json'));
    const installed = provenance['profile'] as Record<string, unknown> | undefined;
    assert(provenance['schemaVersion'] === 1 && typeof installed === 'object' && installed !== null,
      'Who-reacted runtime provenance records its profile');
    assert.deepEqual(installed, {
      requested: GENERAL_TOUCH_PROFILE,
      digest: digest(JSON.stringify(GENERAL_TOUCH_PROFILE)),
    }, 'Who-reacted runtime provenance used the first stage profile');
    for (const entry of WHO_REACTED_STAGES) {
      const applied = await readJsonObject(join(output, entry.id, 'profile-applied.json'));
      assert.deepEqual(applied['requested'], WHO_REACTED_PROFILES[entry.id],
        `Who-reacted ${entry.id} applied its own profile`);
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
export async function revokeWhoReactedPublicationOnAbort(
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
  if (stage) stage.error = 'Cancelled before who-reacted publication';
  await writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
}
