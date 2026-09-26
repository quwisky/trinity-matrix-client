import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MaestroDevice } from './maestro-session.mts';
import type { NativeTargetPoint } from './maestro-target-point.mts';

const downloadDirectory = '/sdcard/Download';
const DOCUMENTS_UI = 'com.google.android.documentsui';

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

/**
 * Read-only: the native tap that opens the picker no longer waits for
 * Maestro's settle heuristic, so poll the native hierarchy until the picker's
 * tab row has rendered and come to rest, within a bound.
 */
async function waitForPhotoPickerOverflowPoint(
  device: MaestroDevice,
  timeoutMs = 15_000,
): Promise<NativeTargetPoint> {
  const deadline = Date.now() + timeoutMs;
  let previous: NativeTargetPoint | undefined;
  for (;;) {
    try {
      // The picker sheet slides up: use the overflow point once two
      // consecutive hierarchies place it identically.
      const point = photoPickerOverflowPoint(
        await device.adb('exec-out', 'uiautomator', 'dump', '/dev/tty'),
      );
      if (previous?.x === point.x && previous.y === point.y) return point;
      if (Date.now() >= deadline) return point;
      previous = point;
    } catch (error) {
      if (
        !(error instanceof assert.AssertionError) ||
        error.message !== 'Photo picker has one Photos/Albums tab row' ||
        Date.now() >= deadline
      )
        throw error;
    }
    await delay(500);
  }
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
    const overflow = await waitForPhotoPickerOverflowPoint(device);
    // DocumentsUI keeps its last view mode and root across launches on one
    // emulator, and the flow expects its first-launch grid of Recent: a second
    // pick in the same emulator found no "List view" to tap.
    assert.equal(
      await device.adb('shell', 'pm', 'clear', DOCUMENTS_UI),
      'Success',
      'DocumentsUI starts from its first-launch state',
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
