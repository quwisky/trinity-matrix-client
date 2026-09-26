import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MESSAGE_LINKIFY_ASSERTIONS } from './message-linkify-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  redactMaestroArtifacts,
} from './maestro-session.mts';

const raster = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp',
]);
// Maestro flow files the native client generates (for example keyboard dismissal)
// are plain YAML and are scanned like every other text diagnostic.
const publishableText = new Set(['.json', '.jsonl', '.log', '.txt', '.xml', '.yaml']);

export interface LinkifyPublicationSafety {
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

/** Match component-encoded secrets without decoding or changing other log text. */
function encodedSecretPatterns(secrets: Readonly<Record<string, string>>): readonly RegExp[] {
  return [...new Set(Object.values(secrets).filter(Boolean).map((value) => encodeURIComponent(value)))]
    .sort((left, right) => right.length - left.length)
    .map((value) => new RegExp(
      value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
        .replace(/%[0-9A-F]{2}/gu, (escape) =>
          escape.replace(/[A-F]/gu, (hex) => `[${hex}${hex.toLowerCase()}]`)),
      'u',
    ));
}

/** Remove local raster proof and redact text before the final fail-closed scan. */
export async function scrubLinkifyArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  await redactMaestroArtifacts(output, secrets, true);
  const encoded = encodedSecretPatterns(secrets);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) await scrubLinkifyArtifacts(path, secrets);
    else {
      assert(entry.isFile(), 'Linkify diagnostic is a regular file');
      if (raster.has(extname(path).toLowerCase())) await unlink(path);
      else if (publishableText.has(extname(path).toLowerCase())) {
        const value = await readFile(path, 'utf8');
        const redacted = encoded.reduce((text, pattern) =>
          text.replaceAll(new RegExp(pattern, 'gu'), '[REDACTED]'), value);
        if (redacted !== value) await writeFile(path, redacted, 'utf8');
      }
    }
  }
}

/** Reject unredacted identifiers, native storage payloads, and any raster. */
export async function scanLinkifyArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const values = Object.values(secrets).filter(Boolean).flatMap((value) =>
    [value, JSON.stringify(value).slice(1, -1)]);
  const encoded = encodedSecretPatterns(secrets);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) {
      await scanLinkifyArtifacts(path, secrets);
      continue;
    }
    assert(entry.isFile() &&
      (entry.name === 'publication-safe' ||
        publishableText.has(extname(path).toLowerCase())),
    'Linkify diagnostics contain only recognized text files');
    const value = await readFile(path, 'utf8');
    for (const secret of values)
      assert(!value.includes(secret), 'No raw credential or identifier in linkify diagnostics');
    for (const pattern of encoded)
      assert(!pattern.test(value), 'No URL-encoded credential or identifier in linkify diagnostics');
    assert(!/\bBearer\s+\S+|\bsyt_[A-Za-z0-9._~-]+/u.test(value),
      'Authorization absent from linkify diagnostics');
    assert(!/<(?:map\b|string\b)[^>]*>/iu.test(value),
      'Raw native Preferences XML absent from linkify diagnostics');
    assert(nativeStorageMethodDataIsRedacted(value, 'Preferences'),
      'Preferences diagnostic data is redacted');
    assert(nativeStorageMethodDataIsRedacted(value, 'SecureStorage'),
      'SecureStorage diagnostic data is redacted');
  }
}

async function requireTextFile(path: string): Promise<void> {
  const metadata = await stat(path);
  assert(metadata.isFile() && metadata.size > 0,
    'Required linkify text capture or provenance exists');
}

/** Only a complete, captured, cleaned stage may receive the hosted upload marker. */
export async function markLinkifyDiagnosticsSafe(
  output: string,
  secrets: Readonly<Record<string, string>>,
  flags: Readonly<LinkifyPublicationSafety>,
  signal?: AbortSignal,
): Promise<void> {
  const marker = join(output, 'publication-safe');
  try {
    signal?.throwIfAborted();
    assert(!flags.unsafeSecrets && !flags.cleanupFailed && !flags.scrubFailed,
      'Incomplete secrets, cleanup or scrub blocks linkify publication');
    const report = JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8')) as Record<string, unknown>;
    assert(report['status'] === 'passed' && report['expectedStages'] === 1 &&
      report['expectedAssertionRecords'] === 2 && report['attempt'] === 1 &&
      report['retries'] === 0, 'Linkify report has one successful unretried stage');
    assert(Array.isArray(report['stages']) && report['stages'].length === 1,
      'Linkify report has exactly one stage');
    const stage = report['stages'][0] as Record<string, unknown>;
    assert(stage['id'] === 'message-linkify' && stage['status'] === 'passed' &&
      stage['attempt'] === 1 && stage['retries'] === 0 &&
      stage['expectedAssertionRecords'] === 2 && stage['assertionRecords'] === 2 &&
      stage['failureCount'] === 0, 'Linkify stage has 2 successful records');
    assert.deepEqual(stage['assertions'], MESSAGE_LINKIFY_ASSERTIONS,
      'Linkify parity identities are complete and source ordered');
    await requireTextFile(join(output, 'runtime-provenance.json'));
    for (const name of ['passed.json', 'passed-ui.json', 'passed-surface.json'])
      await requireTextFile(join(output, 'message-linkify', name));
    await scanLinkifyArtifacts(output, secrets);
    signal?.throwIfAborted();
    await writeFile(marker, 'scanned\n', { signal });
    signal?.throwIfAborted();
  } catch (error) {
    await rm(marker, { force: true });
    throw error;
  }
}

/** Run every local teardown step, even after a prior one fails. */
export async function runLinkifyStageCleanup(
  actions: readonly (() => Promise<void>)[],
  failures: unknown[],
): Promise<void> {
  for (const action of actions) {
    try { await action(); }
    catch (error) { failures.push(error); }
  }
}

/** A late abort must not retain a success report or publication marker. */
export async function revokeLinkifyPublicationOnAbort(
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
  if (stage) stage.error = 'Cancelled before linkify publication';
  await writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
}
