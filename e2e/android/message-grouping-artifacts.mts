import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MESSAGE_GROUPING_ASSERTIONS } from './message-grouping-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  redactMaestroArtifacts,
} from './maestro-session.mts';

const raster = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp',
]);
const publishableText = new Set(['.json', '.jsonl', '.log', '.txt', '.xml']);

export interface GroupingPublicationSafety {
  unsafeSecrets: boolean;
  cleanupFailed: boolean;
  scrubFailed: boolean;
}

interface AbortReport {
  status: 'running' | 'passed' | 'failed';
  readonly stages: readonly {
    status: 'running' | 'passed' | 'failed';
    failureCount: number;
    error?: string;
  }[];
}

/** Remove local raster proof and redact text before the final fail-closed scan. */
export async function scrubGroupingArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  await redactMaestroArtifacts(output, secrets, true);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) await scrubGroupingArtifacts(path, secrets);
    else {
      assert(entry.isFile(), 'Grouping diagnostic is a regular file');
      if (raster.has(extname(path).toLowerCase())) await unlink(path);
    }
  }
}

/** Reject unredacted identifiers, native storage payloads, and any raster. */
export async function scanGroupingArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const values = Object.values(secrets).filter(Boolean).flatMap((value) =>
    [value, JSON.stringify(value).slice(1, -1)]);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) {
      await scanGroupingArtifacts(path, secrets);
      continue;
    }
    assert(entry.isFile() &&
      (entry.name === 'publication-safe' ||
        publishableText.has(extname(path).toLowerCase())),
    'Grouping diagnostics contain only recognized text files');
    const value = await readFile(path, 'utf8');
    for (const secret of values)
      assert(!value.includes(secret), 'No raw credential or identifier in grouping diagnostics');
    assert(!/\bBearer\s+\S+|\bsyt_[A-Za-z0-9._~-]+/u.test(value),
      'Authorization absent from grouping diagnostics');
    assert(!/<(?:map\b|string\b)[^>]*>/iu.test(value),
      'Raw native Preferences XML absent from grouping diagnostics');
    assert(nativeStorageMethodDataIsRedacted(value, 'Preferences'),
      'Preferences diagnostic data is redacted');
    assert(nativeStorageMethodDataIsRedacted(value, 'SecureStorage'),
      'SecureStorage diagnostic data is redacted');
  }
}

async function requireTextFile(path: string): Promise<void> {
  const metadata = await stat(path);
  assert(metadata.isFile() && metadata.size > 0,
    'Required grouping text capture or provenance exists');
}

/** Only a complete, captured, cleaned stage may receive the hosted upload marker. */
export async function markGroupingDiagnosticsSafe(
  output: string,
  secrets: Readonly<Record<string, string>>,
  flags: Readonly<GroupingPublicationSafety>,
  signal?: AbortSignal,
): Promise<void> {
  const marker = join(output, 'publication-safe');
  try {
    signal?.throwIfAborted();
    assert(!flags.unsafeSecrets && !flags.cleanupFailed && !flags.scrubFailed,
      'Incomplete secrets, cleanup or scrub blocks grouping publication');
    const report = JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8')) as Record<string, unknown>;
    assert(report['status'] === 'passed' && report['expectedStages'] === 1 &&
      report['expectedAssertionRecords'] === 22 && report['attempt'] === 1 &&
      report['retries'] === 0, 'Grouping report has one successful unretried stage');
    assert(Array.isArray(report['stages']) && report['stages'].length === 1,
      'Grouping report has exactly one stage');
    const stage = report['stages'][0] as Record<string, unknown>;
    assert(stage['id'] === 'message-grouping' && stage['status'] === 'passed' &&
      stage['attempt'] === 1 && stage['retries'] === 0 &&
      stage['expectedAssertionRecords'] === 22 && stage['assertionRecords'] === 22 &&
      stage['failureCount'] === 0, 'Grouping stage has 22 successful records');
    assert.deepEqual(stage['assertions'], MESSAGE_GROUPING_ASSERTIONS,
      'Grouping parity identities are complete and source ordered');
    await requireTextFile(join(output, 'runtime-provenance.json'));
    for (const name of ['passed.json', 'passed-ui.json', 'passed-surface.json'])
      await requireTextFile(join(output, 'message-grouping', name));
    await scanGroupingArtifacts(output, secrets);
    signal?.throwIfAborted();
    await writeFile(marker, 'scanned\n', { signal });
    signal?.throwIfAborted();
  } catch (error) {
    await rm(marker, { force: true });
    throw error;
  }
}

/** Run every local teardown step, even after a prior one fails. */
export async function runGroupingStageCleanup(
  actions: readonly (() => Promise<void>)[],
  failures: unknown[],
): Promise<void> {
  for (const action of actions) {
    try { await action(); }
    catch (error) { failures.push(error); }
  }
}

/** A late abort must not retain a success report or publication marker. */
export async function revokeGroupingPublicationOnAbort(
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
  if (stage) stage.error = 'Cancelled before grouping publication';
  await writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
}
