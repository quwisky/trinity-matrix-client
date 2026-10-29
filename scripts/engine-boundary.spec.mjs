import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const allowlistPath = 'architecture/engine-boundary-allowlist.json';
const sdkReach =
  /from ['"]matrix-js-sdk(?:\/[^'"]*)?['"]|\.clientFor\(|\.holderFor\(|\bmatrix\.instance\b|\.detachedClient\(|MatrixClientService\[\s*['"](?:clientFor|holderFor|instance|all|detachedClient)['"]\s*\]/;
const utilMatrixImport =
  /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@trinity\/util\/matrix['"]/g;
const sdkClasses = new Set(['ConnectionError', 'HTTPError', 'MatrixError']);

/** Whether a source file outside `js-sdk/` reaches matrix-js-sdk, directly or through a re-export. */
export function reachesSdk(file, source) {
  if (
    file.endsWith('.spec.ts') ||
    file.endsWith('.spec-harness.ts') ||
    file.includes('/js-sdk/')
  ) {
    return false;
  }
  if (sdkReach.test(source)) return true;
  if (/\.all\(\)/.test(source) && source.includes('MatrixClientService'))
    return true;
  return [...source.matchAll(utilMatrixImport)].some(([, specifiers]) =>
    specifiers.split(',').some((specifier) =>
      sdkClasses.has(
        specifier
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+/)[0],
      ),
    ),
  );
}

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
    .filter((file) =>
      reachesSdk(file, readFileSync(join(workspaceRoot, file), 'utf8')),
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

describe('reachesSdk', () => {
  const file = 'libs/x/src/a.ts';

  it('matches a multi-line util/matrix import of an SDK class', () => {
    const source =
      "import {\n  type Foo,\n  MatrixError,\n} from '@trinity/util/matrix';";
    expect(reachesSdk(file, source)).toBe(true);
  });

  it('ignores a comment that only names the class', () => {
    expect(
      reachesSdk(
        file,
        "// MatrixError\nimport { Foo } from '@trinity/util/matrix';",
      ),
    ).toBe(false);
  });

  it('matches type-level client access', () => {
    const source =
      "type C = NonNullable<ReturnType<MatrixClientService['clientFor']>>;";
    expect(reachesSdk(file, source)).toBe(true);
  });

  it('matches the secret-storage key holder outside adapters and harnesses', () => {
    const source = 'inject(JS_SDK_CLIENTS).holderFor(accountId)';
    expect(reachesSdk(file, source)).toBe(true);
    expect(
      reachesSdk(
        file,
        "type H = ReturnType<MatrixClientService['holderFor']>;",
      ),
    ).toBe(true);
    expect(reachesSdk('libs/y/a.spec-harness.ts', source)).toBe(false);
    expect(reachesSdk('libs/y/js-sdk/a.ts', source)).toBe(false);
  });

  it('matches .all() only with MatrixClientService', () => {
    expect(reachesSdk(file, 'this.matrix.all()')).toBe(false);
    expect(
      reachesSdk(file, 'const m = inject(MatrixClientService); m.all()'),
    ).toBe(true);
  });

  it('matches detachedClient calls and skips harnesses and adapters', () => {
    expect(reachesSdk(file, 'x.detachedClient(url)')).toBe(true);
    expect(reachesSdk('a.spec-harness.ts', 'x.detachedClient(url)')).toBe(
      false,
    );
    expect(reachesSdk('libs/y/js-sdk/a.ts', 'x.detachedClient(url)')).toBe(
      false,
    );
  });
});
