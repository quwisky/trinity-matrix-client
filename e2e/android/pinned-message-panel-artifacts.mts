import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PIXEL_5_ACCOUNT_PROFILE } from './account-workspace-client.mts';
import {
  PINNED_PANEL_ASSERTION_RECORDS,
  PINNED_PANEL_STAGES,
  type PinnedPanelStageId,
} from './pinned-message-panel-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  redactMaestroArtifacts,
} from './maestro-session.mts';
import {
  hasMatrixIdentifier,
  redactMatrixIdentifiers,
} from '../support/matrix-identifiers.mts';

const raster = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp',
]);
// Maestro flow files the native client generates (for example long presses and
// keyboard dismissal) are plain YAML and are scanned like every other text diagnostic.
const publishableText = new Set(['.json', '.jsonl', '.log', '.txt', '.xml', '.yaml']);
const PASSED_CAPTURES = ['passed.json', 'passed-ui.json', 'passed-surface.json'] as const;
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
/**
 * A generic defence: an event field carrying a raw identifier, plain or
 * JSON-escaped once or twice, blocks publication independently of the
 * registered values.
 */
const RAW_EVENT_IDENTIFIER =
  /(?:\\*")(?:event_id|room_id|sender)(?:\\*")\s*:\s*(?:\\*")[$!@]/u;

export interface PinnedPanelPublicationSafety {
  unsafeSecrets: boolean;
  cleanupFailed: boolean;
  scrubFailed: boolean;
}

/** Every identifier the one stage creates, for one Account and one Room. */
export interface PinnedPanelSecretIds {
  readonly accounts: readonly {
    readonly userId: string;
    readonly username: string;
    readonly password: string;
  }[];
  readonly rooms: readonly { readonly id?: string; readonly name?: string }[];
  /** Run-scoped texts: both message bodies. */
  readonly texts: readonly string[];
  readonly eventIds: readonly string[];
  /** Each transaction id is also one of the bodies (D2), registered again for its own key. */
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
export function pinnedPanelSecrets(
  stage: PinnedPanelStageId,
  ids: PinnedPanelSecretIds,
): Record<string, string> {
  assert(PINNED_PANEL_STAGES.some((entry) => entry.id === stage),
    'Pinned-panel secrets belong to a contract stage');
  const prefix = `SECRET_PANEL_${stage.toUpperCase().replaceAll('-', '_')}`;
  const values: Record<string, string> = {};
  const add = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    assert(typeof value === 'string' && value.length > 0,
      'Pinned-panel secret values are non-empty strings');
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
    assert(value !== 'localhost', 'The bare server name is never a pinned-panel secret');
  return values;
}

const hexEscape = (byte: number): string =>
  `%(?:25)*${byte.toString(16).toUpperCase().padStart(2, '0')
    .replace(/[A-F]/gu, (hex) => `[${hex}${hex.toLowerCase()}]`)}`;

/** One character as itself or any single- or multiply-percent-encoded UTF-8 form. */
const characterPattern = (character: string): string => {
  const literal = character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const encoded = [...new TextEncoder().encode(character)].map(hexEscape).join('');
  return character === ' '
    ? `(?:${literal}|\\+|${encoded})`
    : `(?:${literal}|${encoded})`;
};

/** Match each secret in any percent-encoded form with case-insensitive hex. */
export function encodedSecretPatterns(
  secrets: Readonly<Record<string, string>>,
): readonly RegExp[] {
  return [...new Set(Object.values(secrets).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((value) => new RegExp([...value].map(characterPattern).join(''), 'u'));
}

const escapedSecretValues = (secrets: Readonly<Record<string, string>>): readonly string[] =>
  [...new Set(Object.values(secrets).filter(Boolean).flatMap((value) =>
    [value, JSON.stringify(value).slice(1, -1)]))]
    .sort((left, right) => right.length - left.length);

/** Redact every registered secret, raw, JSON-escaped or percent-encoded, from text. */
export function redactSecretText(
  text: string,
  secrets: Readonly<Record<string, string>>,
): string {
  let redacted = text;
  for (const value of escapedSecretValues(secrets))
    redacted = redacted.split(value).join('[REDACTED]');
  for (const pattern of encodedSecretPatterns(secrets))
    redacted = redacted.replace(new RegExp(pattern.source, 'gu'), '[REDACTED]');
  return redacted;
}

/**
 * Redact every registered secret and every Matrix Room and event-id shape from
 * text. The SDK logs the Room's state-event ids to logcat ("Event $… already in
 * timeline"); none is registered, so the shared shapes are redacted as well.
 */
export function redactDiagnosticText(
  text: string,
  secrets: Readonly<Record<string, string>>,
): string {
  return redactMatrixIdentifiers(redactSecretText(text, secrets));
}

/** Remove local raster proof and redact text before the final fail-closed scan. */
export async function scrubPinnedPanelArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  await redactMaestroArtifacts(output, secrets, true);
  const scrub = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scrub(path);
      else {
        assert(entry.isFile(), 'Pinned-panel diagnostic is a regular file');
        if (raster.has(extname(path).toLowerCase())) await unlink(path);
        else if (publishableText.has(extname(path).toLowerCase())) {
          const value = await readFile(path, 'utf8');
          const redacted = redactDiagnosticText(value, secrets);
          if (redacted !== value) await writeFile(path, redacted, 'utf8');
        }
      }
    }
  };
  await scrub(output);
}

/** Reject unredacted identifiers, authorization, native storage payloads, and any raster. */
export async function scanPinnedPanelArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const values = escapedSecretValues(secrets);
  const encoded = encodedSecretPatterns(secrets);
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      assert(!raster.has(extname(path).toLowerCase()),
        'No raster proof in pinned-panel diagnostics');
      assert(entry.isFile() &&
        (entry.name === 'publication-safe' ||
          publishableText.has(extname(path).toLowerCase())),
      'Pinned-panel diagnostics contain only recognized text files');
      const value = await readFile(path, 'utf8');
      for (const secret of values)
        assert(!value.includes(secret), 'No raw credential or identifier in pinned-panel diagnostics');
      for (const pattern of encoded)
        assert(!pattern.test(value), 'No URL-encoded credential or identifier in pinned-panel diagnostics');
      assert(!/syt_|\bBearer\s+\S+/iu.test(value),
        'Authorization absent from pinned-panel diagnostics');
      assert(!/access_token["']?\s*[:=]\s*["']?[\w.~-]{8,}/iu.test(value),
        'Query-string and JSON access tokens absent from pinned-panel diagnostics');
      assert(!hasMatrixIdentifier(value),
        'No Matrix Room or event id in pinned-panel diagnostics');
      assert(!RAW_EVENT_IDENTIFIER.test(value),
        'No raw event, Room or sender identifier of a Matrix event JSON in pinned-panel diagnostics');
      assert(!/<(?:map\b|string\b)[^>]*>/iu.test(value),
        'Raw native Preferences XML absent from pinned-panel diagnostics');
      assert(nativeStorageMethodDataIsRedacted(value, 'Preferences'),
        'Preferences diagnostic data is redacted');
      assert(nativeStorageMethodDataIsRedacted(value, 'SecureStorage'),
        'SecureStorage diagnostic data is redacted');
    }
  };
  await scan(output);
}

async function requireTextFile(path: string): Promise<void> {
  const metadata = await stat(path);
  assert(metadata.isFile() && metadata.size > 0,
    'Required pinned-panel text capture or provenance exists');
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  await requireTextFile(path);
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(typeof value === 'object' && value !== null && !Array.isArray(value),
    'Pinned-panel diagnostic JSON is an object');
  return value as Record<string, unknown>;
}

function assertPassedReport(report: Record<string, unknown>): void {
  assert(report['status'] === 'passed' &&
    report['expectedStages'] === PINNED_PANEL_STAGES.length &&
    report['expectedAssertionRecords'] === PINNED_PANEL_ASSERTION_RECORDS &&
    report['attempt'] === 1 && report['retries'] === 0,
  'Pinned-panel report has every successful unretried stage');
  assert(Array.isArray(report['stages']) &&
    report['stages'].length === PINNED_PANEL_STAGES.length,
  'Pinned-panel report has exactly the contract stages');
  const identities = new Set<unknown>();
  PINNED_PANEL_STAGES.forEach((entry, index) => {
    const stage = (report['stages'] as unknown[])[index] as Record<string, unknown>;
    assert(typeof stage === 'object' && stage !== null,
      'Pinned-panel stage report is an object');
    assert(stage['id'] === entry.id && stage['status'] === 'passed' &&
      stage['attempt'] === 1 && stage['retries'] === 0 &&
      stage['expectedAssertionRecords'] === entry.expectedAssertionRecords &&
      stage['assertionRecords'] === entry.assertions.length &&
      stage['failureCount'] === 0,
    `Pinned-panel stage ${index + 1} is ${entry.id} with every record passed`);
    assert.deepEqual(stage['assertions'], [...entry.assertions],
      `Pinned-panel ${entry.id} parity identities are complete and source ordered`);
    for (const identity of entry.assertions) identities.add(identity);
  });
  assert.equal(identities.size, PINNED_PANEL_ASSERTION_RECORDS,
    'Pinned-panel parity identities are unique across stages');
}

/** Only a complete, captured, cleaned one-stage run may receive the hosted upload marker. */
export async function markPinnedPanelDiagnosticsSafe(
  output: string,
  secrets: Readonly<Record<string, string>>,
  flags: Readonly<PinnedPanelPublicationSafety>,
  signal: AbortSignal | undefined,
  report: object,
): Promise<void> {
  const marker = join(output, 'publication-safe');
  try {
    signal?.throwIfAborted();
    assert(!flags.unsafeSecrets && !flags.cleanupFailed && !flags.scrubFailed,
      'Incomplete secrets, cleanup or scrub blocks pinned-panel publication');
    const current = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    assertPassedReport(current);
    assert.deepEqual(await readJsonObject(join(output, 'journeys.json')), current,
      'Persisted pinned-panel report matches the run');
    const provenance = await readJsonObject(join(output, 'runtime-provenance.json'));
    const installed = provenance['profile'] as Record<string, unknown> | undefined;
    assert(provenance['schemaVersion'] === 1 && typeof installed === 'object' && installed !== null,
      'Pinned-panel runtime provenance records its profile');
    assert.deepEqual(installed, {
      requested: PIXEL_5_ACCOUNT_PROFILE,
      digest: digest(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
    }, 'Pinned-panel runtime provenance used the Pixel 5 profile');
    for (const entry of PINNED_PANEL_STAGES) {
      const applied = await readJsonObject(join(output, entry.id, 'profile-applied.json'));
      assert.deepEqual(applied['requested'], PIXEL_5_ACCOUNT_PROFILE,
        `Pinned-panel ${entry.id} applied the Pixel 5 profile`);
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

/** Run every local teardown step, even after a prior one fails. */
export async function runPinnedPanelStageCleanup(
  actions: readonly (() => Promise<void>)[],
  failures: unknown[],
): Promise<void> {
  for (const action of actions) {
    try { await action(); }
    catch (error) { failures.push(error); }
  }
}

/** A late abort must not retain a success report or publication marker. */
export async function revokePinnedPanelPublicationOnAbort(
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
  if (stage) stage.error = 'Cancelled before pinned-panel publication';
  await writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
}
