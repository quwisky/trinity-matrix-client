import { join } from 'node:path';
import type { MaestroDevice } from './maestro-session.mts';

const downloadDirectory = '/sdcard/Download';

/** Stage a local document in Downloads and select it through Android DocumentsUI. */
export async function pickAndroidDocument(
  device: MaestroDevice,
  workspaceRoot: string,
  localPath: string,
  remoteName: string,
): Promise<void> {
  if (/[\\/]/u.test(remoteName))
    throw new Error('Android document name must not contain a path separator');

  const remotePath = `${downloadDirectory}/${remoteName}`;
  try {
    await device.adb('push', localPath, remotePath);
    await device.runFlow(
      join(workspaceRoot, 'e2e/android/flows/accounts-document-pick.yaml'),
      { APP_ID: 'eu.qwky.trinity', FILE_NAME: remoteName },
    );
  } finally {
    await device.adb('shell', 'rm', '-f', remotePath);
  }
}
