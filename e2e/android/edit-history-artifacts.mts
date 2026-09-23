import assert from 'node:assert/strict';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { NodeWorkspaceAccount } from './account-workspace-fixtures.mts';
import type { LifecycleSeed, PixelSeed } from './edit-history-fixture.mts';
import {
  nativeStorageMethodDataIsRedacted,
  redactMaestroArtifacts,
} from './maestro-session.mts';

const raster = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** Register every fixture identifier as a redactor secret before seeding. */
export function editHistorySecrets(
  stage: string,
  account: Pick<NodeWorkspaceAccount, 'username' | 'userId' | 'password'>,
  roomName: string,
  seed?: LifecycleSeed | PixelSeed,
): Record<string, string> {
  const prefix = `SECRET_${stage.toUpperCase().replaceAll('-', '_')}`;
  const values: Record<string, string> = {
    [`${prefix}_USERNAME`]: account.username,
    [`${prefix}_USER_ID`]: account.userId,
    [`${prefix}_PASSWORD`]: account.password,
    [`${prefix}_ROOM_NAME`]: roomName,
  };
  if (!seed) return values;
  values[`${prefix}_ROOM_ID`] = seed.roomId;
  if ('plain' in seed) {
    values[`${prefix}_ORIGINAL_EVENT`] = seed.plain.originalId;
    values[`${prefix}_EDIT_ONE_EVENT`] = seed.plain.editIds[0];
    values[`${prefix}_EDIT_TWO_EVENT`] = seed.plain.editIds[1];
    values[`${prefix}_FORMATTED_ORIGINAL_EVENT`] = seed.formatted.originalId;
    values[`${prefix}_FORMATTED_EDIT_EVENT`] = seed.formatted.editId;
    values[`${prefix}_DOOMED_EVENT`] = seed.doomed.originalId;
    values[`${prefix}_DOOMED_EDIT_EVENT`] = seed.doomed.editId;
  } else {
    values[`${prefix}_ORIGINAL_EVENT`] = seed.originalId;
    values[`${prefix}_EDIT_ONE_EVENT`] = seed.editIds[0];
    values[`${prefix}_EDIT_TWO_EVENT`] = seed.editIds[1];
  }
  return values;
}

/** The shared redactor handles text; this also removes all raster formats. */
export async function scrubEditHistoryArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  await redactMaestroArtifacts(output, secrets, true);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) await scrubEditHistoryArtifacts(path, secrets);
    else {
      assert(entry.isFile(), 'Edit-history diagnostic is a regular file');
      if (raster.has(extname(path).toLowerCase())) await unlink(path);
    }
  }
}

/** Fail closed on an omitted redaction or an unsafe binary diagnostic. */
export async function scanEditHistoryArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const values = Object.values(secrets).filter(Boolean).flatMap((value) =>
    [value, JSON.stringify(value).slice(1, -1)]);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) {
      await scanEditHistoryArtifacts(path, secrets);
      continue;
    }
    assert(entry.isFile() && !raster.has(extname(path).toLowerCase()),
      'No unsafe diagnostic raster or special file');
    const value = await readFile(path, 'utf8');
    for (const secret of values)
      assert(!value.includes(secret), 'No raw credential or identifier in diagnostics');
    assert(!/\bBearer\s+\S+|\bsyt_[A-Za-z0-9._~-]+/u.test(value),
      'Authorization absent from diagnostics');
    assert(nativeStorageMethodDataIsRedacted(value, 'Preferences'),
      'Preferences diagnostic data is redacted');
    assert(nativeStorageMethodDataIsRedacted(value, 'SecureStorage'),
      'SecureStorage diagnostic data is redacted');
  }
}
