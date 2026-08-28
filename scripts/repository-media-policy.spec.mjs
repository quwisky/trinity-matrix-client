import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const trackedFiles = execFileSync('git', ['ls-files'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter((file) => file && existsSync(join(workspaceRoot, file)));

const PRODUCT_MEDIA_ROOTS = [
  'android/app/src/main/res/',
  'apps/trinity/src/assets/',
  'electron/build/',
  'ios/App/App/Assets.xcassets/',
];
const RASTER_MEDIA = /\.(?:gif|jpe?g|png|webp)$/i;
const PROTOTYPE_PATH = /(^|\/)prototypes?(\/|$)/i;

describe('repository review-media policy', () => {
  it('keeps prototypes and review evidence out of tracked source', () => {
    const forbidden = trackedFiles.filter(
      (file) =>
        file.startsWith('docs/evidence/') ||
        PROTOTYPE_PATH.test(file) ||
        (file.includes('-snapshots/') && RASTER_MEDIA.test(file)),
    );

    expect(forbidden).toEqual([]);
  });

  it('tracks raster media only when it is a shipping application asset', () => {
    const forbidden = trackedFiles.filter(
      (file) =>
        RASTER_MEDIA.test(file) &&
        !PRODUCT_MEDIA_ROOTS.some((root) => file.startsWith(root)),
    );

    expect(forbidden).toEqual([]);
  });
});
