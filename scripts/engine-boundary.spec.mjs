import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const adapterFolder = /^libs\/data-access\/[^/]+\/src\/lib\/js-sdk\//;
const sdkReach =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](?:matrix-js-sdk(?:\/[^'"]*)?|@matrix-org\/matrix-sdk-crypto-wasm)['"]|\.clientFor\(|\.holderFor\(|\bmatrix\.instance\b|\.detachedClient\(|MatrixClientService\[\s*['"](?:clientFor|holderFor|instance|all|detachedClient)['"]\s*\]/;

/** Whether a source file outside a data-access `js-sdk/` folder reaches matrix-js-sdk or its crypto WASM. */
export function reachesSdk(file, source) {
  if (
    file.endsWith('.spec.ts') ||
    file.endsWith('.spec-harness.ts') ||
    adapterFolder.test(file)
  ) {
    return false;
  }
  if (sdkReach.test(source)) return true;
  return /\.all\(\)/.test(source) && source.includes('MatrixClientService');
}

/** The engine boundary (#1153): only `js-sdk/` adapters reach matrix-js-sdk. */
describe('Engine boundary', () => {
  it('has no SDK reach outside js-sdk/ folders', () => {
    const offenders = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
      cwd: workspaceRoot,
      exclude: (name) => name === 'node_modules',
    }).filter((file) =>
      reachesSdk(file, readFileSync(join(workspaceRoot, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('reachesSdk', () => {
  const file = 'libs/x/src/a.ts';
  const adapter = 'libs/data-access/y/src/lib/js-sdk/a.ts';

  it('matches every import form of the SDK and the crypto WASM', () => {
    for (const source of [
      "const sdk = await import('matrix-js-sdk');",
      "type E = import('matrix-js-sdk').MatrixEvent;",
      "import 'matrix-js-sdk';",
      "import sdk = require('matrix-js-sdk');",
      "const { initAsync } = await import('@matrix-org/matrix-sdk-crypto-wasm');",
      "export { MatrixEvent } from 'matrix-js-sdk/lib/models/event';",
    ]) {
      expect(reachesSdk(file, source), source).toBe(true);
      expect(reachesSdk(adapter, source), source).toBe(false);
    }
    expect(reachesSdk(file, "const prefix = 'matrix-js-sdk';")).toBe(false);
  });

  it('exempts only the js-sdk folder of a data-access library', () => {
    const source = "import { createClient } from 'matrix-js-sdk';";
    expect(reachesSdk(adapter, source)).toBe(false);
    expect(reachesSdk('libs/feature/y/src/lib/js-sdk/a.ts', source)).toBe(true);
    expect(reachesSdk('libs/data-access/y/src/js-sdk/a.ts', source)).toBe(true);
  });

  it('matches an import of the crypto WASM', () => {
    expect(
      reachesSdk(
        file,
        "import { initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';",
      ),
    ).toBe(true);
    expect(
      reachesSdk(
        adapter,
        "import { initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';",
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
    expect(reachesSdk(adapter, source)).toBe(false);
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
    expect(reachesSdk(adapter, 'x.detachedClient(url)')).toBe(false);
  });
});
