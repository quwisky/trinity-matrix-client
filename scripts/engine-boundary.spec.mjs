import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const allowlistPath = 'architecture/engine-boundary-allowlist.json';
const sdkReach =
  /from ['"]matrix-js-sdk(?:\/[^'"]*)?['"]|\.clientFor\(|\bmatrix\.instance\b/;

/**
 * Ratchet the engine boundary (#1153): only `js-sdk/` adapters reach matrix-js-sdk.
 * The allowlist holds the files that still do; it may only shrink.
 */
describe('Engine boundary', () => {
  const { files: allowlist } = JSON.parse(
    readFileSync(join(workspaceRoot, allowlistPath), 'utf8'),
  );
  const offenders = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
    cwd: workspaceRoot,
    exclude: (name) => name === 'node_modules',
  })
    .filter(
      (file) =>
        !file.endsWith('.spec.ts') &&
        !file.includes('/js-sdk/') &&
        sdkReach.test(readFileSync(join(workspaceRoot, file), 'utf8')),
    )
    .sort();

  it('adds no new SDK reach', () => {
    expect(offenders.filter((file) => !allowlist.includes(file))).toEqual([]);
  });

  it('drops entries that no longer reach the SDK', () => {
    expect(allowlist.filter((file) => !offenders.includes(file))).toEqual([]);
  });

  it('keeps the allowlist sorted and unique', () => {
    expect(allowlist).toEqual([...new Set(allowlist)].sort());
  });
});
