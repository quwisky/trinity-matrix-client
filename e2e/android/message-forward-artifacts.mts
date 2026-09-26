import assert from 'node:assert/strict';
import { readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { NodeWorkspaceAccount } from './account-workspace-fixtures.mts';
import {
  nativeStorageMethodDataIsRedacted,
  redactMaestroArtifacts,
} from './maestro-session.mts';

const raster = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export interface ForwardPublicationSafety {
  unsafeSecrets: boolean;
  cleanupFailed: boolean;
  scrubFailed: boolean;
}

interface ForwardAbortReport {
  status: 'running' | 'passed' | 'failed';
  readonly stages: readonly {
    status: 'running' | 'passed' | 'failed';
    failureCount: number;
    error?: string;
  }[];
}

export function forwardSecrets(
  account: Pick<NodeWorkspaceAccount, 'username' | 'userId' | 'password'>,
  sourceName: string,
  targetName: string,
  body: string,
): Record<string, string> {
  return {
    SECRET_FORWARD_USERNAME: account.username,
    SECRET_FORWARD_USER_ID: account.userId,
    SECRET_FORWARD_PASSWORD: account.password,
    SECRET_FORWARD_SOURCE_NAME: sourceName,
    SECRET_FORWARD_TARGET_NAME: targetName,
    SECRET_FORWARD_BODY: body,
    SECRET_FORWARD_BODY_LOWERCASE: `${body.charAt(0).toLowerCase()}${body.slice(1)}`,
  };
}

export function forwardRoomSecrets(
  sourceRoomId: string,
  targetRoomId: string,
): Record<string, string> {
  return {
    SECRET_FORWARD_SOURCE_ROOM_ID: sourceRoomId,
    SECRET_FORWARD_TARGET_ROOM_ID: targetRoomId,
    SECRET_FORWARD_SOURCE_ROOM_SEGMENT: Buffer.from(sourceRoomId).toString('base64url'),
    SECRET_FORWARD_TARGET_ROOM_SEGMENT: Buffer.from(targetRoomId).toString('base64url'),
  };
}

/** Keep captures local, but publish only scrubbed text diagnostics. */
export async function scrubForwardArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  await redactMaestroArtifacts(output, secrets, true);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) await scrubForwardArtifacts(path, secrets);
    else {
      assert(entry.isFile(), 'Forward diagnostic is a regular file');
      if (raster.has(extname(path).toLowerCase())) await unlink(path);
    }
  }
}

/** Fail closed if redaction missed a known secret or binary proof remains. */
export async function scanForwardArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const values = Object.values(secrets).filter(Boolean).flatMap((value) =>
    [value, JSON.stringify(value).slice(1, -1)]);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) {
      await scanForwardArtifacts(path, secrets);
      continue;
    }
    assert(entry.isFile() && !raster.has(extname(path).toLowerCase()),
      'No unsafe forward diagnostic raster or special file');
    const value = await readFile(path, 'utf8');
    for (const secret of values)
      assert(!value.includes(secret), 'No raw credential or identifier in forward diagnostics');
    assert(!/\bBearer\s+\S+|\bsyt_[A-Za-z0-9._~-]+/u.test(value),
      'Authorization absent from forward diagnostics');
    assert(nativeStorageMethodDataIsRedacted(value, 'Preferences'),
      'Preferences diagnostic data is redacted');
    assert(nativeStorageMethodDataIsRedacted(value, 'SecureStorage'),
      'SecureStorage diagnostic data is redacted');
  }
}

export async function markForwardDiagnosticsSafe(
  output: string,
  secrets: Readonly<Record<string, string>>,
  flags: Readonly<ForwardPublicationSafety>,
  signal?: AbortSignal,
): Promise<void> {
  const marker = join(output, 'publication-safe');
  try {
    signal?.throwIfAborted();
    assert(!flags.unsafeSecrets && !flags.cleanupFailed && !flags.scrubFailed,
      'Incomplete secrets or cleanup blocks forward diagnostic publication');
    await scanForwardArtifacts(output, secrets);
    signal?.throwIfAborted();
    await writeFile(marker, 'scanned\n', { signal });
    signal?.throwIfAborted();
  } catch (error) {
    await rm(marker, { force: true });
    throw error;
  }
}

/** Finish both local teardown steps even if the first fails, and poison publication. */
export async function runForwardStageCleanup(
  steps: readonly (() => Promise<void>)[],
  safety: ForwardPublicationSafety,
  failures: unknown[],
): Promise<void> {
  for (const step of steps) {
    try { await step(); }
    catch (error) {
      safety.cleanupFailed = true;
      failures.push(error);
    }
  }
}

/** An aborted test cannot retain a success report or a prior safe marker. */
export async function revokeForwardPublicationOnAbort(
  output: string,
  report: ForwardAbortReport,
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
  if (stage) stage.error = 'Cancelled before forward publication';
  await writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
}
