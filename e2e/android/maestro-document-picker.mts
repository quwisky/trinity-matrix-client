import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { MaestroDevice } from './maestro-session.mts';
import type { NativeTargetPoint } from './maestro-target-point.mts';

const downloadDirectory = '/sdcard/Download';

/** Require the native button followed only by its exact product-owned file input. */
export function assertNativeDocumentActivation(events: unknown): void {
  assert.deepEqual(
    events,
    [
      { trusted: true, matched: true, fileInputMatched: false },
      { trusted: false, matched: false, fileInputMatched: true },
    ],
    'Native document activation requires the exact trusted button and one exact file input follow-on',
  );
}

/** API 36's unlabeled overflow is the sole enabled control right of the Albums tab. */
export function photoPickerOverflowPoint(hierarchy: string): NativeTargetPoint {
  const nodes = [...hierarchy.matchAll(/<node\b[^>]+>/gu)]
    .map(([node]) =>
      Object.fromEntries(
        [...node.matchAll(/([\w-]+)="([^"]*)"/gu)].map(([, key, value]) => [
          key,
          value,
        ]),
      ),
    )
    .filter((node) => node['package'] === 'com.google.android.photopicker')
    .map((node) => {
      const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(
        node['bounds'] ?? '',
      );
      assert(bounds, 'Photo picker node has valid native bounds');
      const [left, top, right, bottom] = bounds.slice(1).map(Number);
      return {
        attributes: node,
        left: left!,
        top: top!,
        right: right!,
        bottom: bottom!,
      };
    });
  const photos = nodes.filter((node) => node.attributes['text'] === 'Photos');
  const albums = nodes.filter((node) => node.attributes['text'] === 'Albums');
  assert(
    photos.length === 1 && albums.length === 1,
    'Photo picker has one Photos/Albums tab row',
  );
  const row = albums[0]!;
  const centerY = (row.top + row.bottom) / 2;
  assert(
    centerY >= photos[0]!.top && centerY <= photos[0]!.bottom,
    'Photo picker tabs share the same row',
  );
  const overflow = nodes.filter(
    (node) =>
      node.attributes['clickable'] === 'true' &&
      node.attributes['enabled'] === 'true' &&
      node.left > row.right &&
      node.top <= centerY &&
      node.bottom >= centerY &&
      node.right > node.left,
  );
  assert.equal(
    overflow.length,
    1,
    'Photo picker has exactly one enabled overflow beside Albums',
  );
  const target = overflow[0]!;
  return {
    x: Math.round((target.left + target.right) / 2),
    y: Math.round((target.top + target.bottom) / 2),
  };
}

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
  const remove = await device.stageFile(localPath, remotePath);
  const failures: unknown[] = [];
  try {
    const overflow = photoPickerOverflowPoint(
      await device.adb('exec-out', 'uiautomator', 'dump', '/dev/tty'),
    );
    await device.runFlow(
      join(workspaceRoot, 'e2e/android/flows/accounts-document-pick.yaml'),
      {
        APP_ID: 'eu.qwky.trinity',
        FILE_NAME: remoteName,
        OVERFLOW_POINT: `${overflow.x},${overflow.y}`,
      },
    );
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await remove();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      'Android document selection and cleanup failed',
    );
}
