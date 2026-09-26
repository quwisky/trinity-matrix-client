import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type {
  NodeWorkspaceAccount,
  WorkspaceMessageActionSheetHistory,
} from './account-workspace-fixtures.mts';
import { nativeStorageMethodDataIsRedacted } from './maestro-session.mts';

/** Every value scanned below must also be selected by the shared redactor. */
export function messageActionSheetSecrets(
  stage: string,
  account: Pick<NodeWorkspaceAccount, 'username' | 'userId' | 'password'>,
  roomName: string,
  history?: Pick<WorkspaceMessageActionSheetHistory, 'targetEventId' | 'oldestFillerEventId'>,
): Record<string, string> {
  return {
    [`SECRET_${stage}_USERNAME`]: account.username,
    [`SECRET_${stage}_USER_ID`]: account.userId,
    [`SECRET_${stage}_PASSWORD`]: account.password,
    [`SECRET_${stage}_ROOM_NAME`]: roomName,
    ...(history ? { [`SECRET_${stage}_TARGET_EVENT_ID`]: history.targetEventId } : {}),
    ...(history?.oldestFillerEventId
      ? { [`SECRET_${stage}_OLDEST_EVENT_ID`]: history.oldestFillerEventId } : {}),
  };
}

export async function scanMessageActionSheetArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const values = Object.values(secrets).filter(Boolean).flatMap((value) =>
    [value, JSON.stringify(value).slice(1, -1)]);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) {
      await scanMessageActionSheetArtifacts(path, secrets);
      continue;
    }
    assert(entry.isFile(), 'Sheet diagnostic must be a regular file');
    assert(!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extname(path).toLowerCase()), 'Sheet rasters must be removed');
    const text = await readFile(path, 'utf8');
    for (const secret of values) assert(!text.includes(secret), `Credential/identifier absent from ${path}`);
    assert(!/\bBearer\s+\S+|\bsyt_[A-Za-z0-9._~-]+/u.test(text), `Authorization absent from ${path}`);
    assert(nativeStorageMethodDataIsRedacted(text, 'Preferences'), `Native Preferences are redacted in ${path}`);
    assert(nativeStorageMethodDataIsRedacted(text, 'SecureStorage'), `Native SecureStorage is redacted in ${path}`);
  }
}
