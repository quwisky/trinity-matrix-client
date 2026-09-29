import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PIXEL_5_ACCOUNT_PROFILE } from './account-workspace-client.mts';
import {
  PINNED_WORKFLOW_ASSERTION_RECORDS,
  PINNED_WORKFLOW_STAGES,
  type PinnedWorkflowStageId,
} from './pinned-message-workflow-contract.mts';
import {
  scanPinnedPanelArtifacts,
  type PinnedPanelPublicationSafety,
} from './pinned-message-panel-artifacts.mts';

/*
 * Suite-specific publication safety for the installed-Android
 * pinned-message-workflow suite (spec open question 2). Scrub, scan,
 * redaction, the encoded-pattern builder and the guarded cleanup runner are
 * #756's stage-free helpers, imported and used unchanged by the journeys
 * (Task 2); only the secrets, marker and abort-revocation stay local here,
 * because they are the only pieces that need this suite's two-stage shape.
 */

const PASSED_CAPTURES = ['passed.json', 'passed-ui.json', 'passed-surface.json'] as const;
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export type PinnedWorkflowPublicationSafety = PinnedPanelPublicationSafety;

/** Every identifier either stage creates, for one Account and one Room. */
export interface PinnedWorkflowSecretIds {
  readonly accounts: readonly {
    readonly userId: string;
    readonly username: string;
    readonly password: string;
  }[];
  readonly rooms: readonly { readonly id?: string; readonly name?: string }[];
  /** Run-scoped texts: both message bodies, and stage 2's 32 filler bodies. */
  readonly texts: readonly string[];
  readonly eventIds: readonly string[];
  /** Each transaction id is also one of the texts (D2), registered again for its own key. */
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
export function pinnedWorkflowSecrets(
  stage: PinnedWorkflowStageId,
  ids: PinnedWorkflowSecretIds,
): Record<string, string> {
  assert(PINNED_WORKFLOW_STAGES.some((entry) => entry.id === stage),
    'Pinned-workflow secrets belong to a contract stage');
  const prefix = `SECRET_WORKFLOW_${stage.toUpperCase().replaceAll('-', '_')}`;
  const values: Record<string, string> = {};
  const add = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    assert(typeof value === 'string' && value.length > 0,
      'Pinned-workflow secret values are non-empty strings');
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
    assert(value !== 'localhost', 'The bare server name is never a pinned-workflow secret');
  return values;
}

async function requireTextFile(path: string): Promise<void> {
  const metadata = await stat(path);
  assert(metadata.isFile() && metadata.size > 0,
    'Required pinned-workflow text capture or provenance exists');
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  await requireTextFile(path);
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(typeof value === 'object' && value !== null && !Array.isArray(value),
    'Pinned-workflow diagnostic JSON is an object');
  return value as Record<string, unknown>;
}

function assertPassedReport(report: Record<string, unknown>): void {
  assert(report['status'] === 'passed' &&
    report['expectedStages'] === PINNED_WORKFLOW_STAGES.length &&
    report['expectedAssertionRecords'] === PINNED_WORKFLOW_ASSERTION_RECORDS &&
    report['attempt'] === 1 && report['retries'] === 0,
  'Pinned-workflow report has every successful unretried stage');
  assert(Array.isArray(report['stages']) &&
    report['stages'].length === PINNED_WORKFLOW_STAGES.length,
  'Pinned-workflow report has exactly the contract stages');
  const identities = new Set<unknown>();
  PINNED_WORKFLOW_STAGES.forEach((entry, index) => {
    const stage = (report['stages'] as unknown[])[index] as Record<string, unknown>;
    assert(typeof stage === 'object' && stage !== null,
      'Pinned-workflow stage report is an object');
    assert(stage['id'] === entry.id && stage['status'] === 'passed' &&
      stage['attempt'] === 1 && stage['retries'] === 0 &&
      stage['expectedAssertionRecords'] === entry.expectedAssertionRecords &&
      stage['assertionRecords'] === entry.assertions.length &&
      stage['failureCount'] === 0,
    `Pinned-workflow stage ${index + 1} is ${entry.id} with every record passed`);
    assert.deepEqual(stage['assertions'], [...entry.assertions],
      `Pinned-workflow ${entry.id} parity identities are complete and source ordered`);
    for (const identity of entry.assertions) identities.add(identity);
  });
  assert.equal(identities.size, PINNED_WORKFLOW_ASSERTION_RECORDS,
    'Pinned-workflow parity identities are unique across stages');
}

/** Only a complete, captured, cleaned two-stage run may receive the hosted upload marker. */
export async function markPinnedWorkflowDiagnosticsSafe(
  output: string,
  secrets: Readonly<Record<string, string>>,
  flags: Readonly<PinnedWorkflowPublicationSafety>,
  signal: AbortSignal | undefined,
  report: object,
): Promise<void> {
  const marker = join(output, 'publication-safe');
  try {
    signal?.throwIfAborted();
    assert(!flags.unsafeSecrets && !flags.cleanupFailed && !flags.scrubFailed,
      'Incomplete secrets, cleanup or scrub blocks pinned-workflow publication');
    const current = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    assertPassedReport(current);
    assert.deepEqual(await readJsonObject(join(output, 'journeys.json')), current,
      'Persisted pinned-workflow report matches the run');
    const provenance = await readJsonObject(join(output, 'runtime-provenance.json'));
    const installed = provenance['profile'] as Record<string, unknown> | undefined;
    assert(provenance['schemaVersion'] === 1 && typeof installed === 'object' && installed !== null,
      'Pinned-workflow runtime provenance records its profile');
    assert.deepEqual(installed, {
      requested: PIXEL_5_ACCOUNT_PROFILE,
      digest: digest(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
    }, 'Pinned-workflow runtime provenance used the Pixel 5 profile');
    for (const entry of PINNED_WORKFLOW_STAGES) {
      const applied = await readJsonObject(join(output, entry.id, 'profile-applied.json'));
      assert.deepEqual(applied['requested'], PIXEL_5_ACCOUNT_PROFILE,
        `Pinned-workflow ${entry.id} applied the Pixel 5 profile`);
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
export async function revokePinnedWorkflowPublicationOnAbort(
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
  if (stage) stage.error = 'Cancelled before pinned-workflow publication';
  await writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
}
