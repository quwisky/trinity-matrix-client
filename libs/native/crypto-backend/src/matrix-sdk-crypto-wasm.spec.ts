import * as facade from '@matrix-org/matrix-sdk-crypto-wasm';
import * as real from '@matrix-org/matrix-sdk-crypto-wasm-real';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WASM = '@matrix-org/matrix-sdk-crypto-wasm';
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const requireHere = createRequire(import.meta.url);
// pnpm links the SDK's dependencies beside it, so this is the copy its imports load.
const sdk = realpathSync(here('../../../../node_modules/matrix-js-sdk'));

type Exports = string | null | { readonly [condition: string]: Exports };

/** The target of a package's `"."` export under `conditions`, as a bundler picks it. */
const exportTarget = (
  packageDir: string,
  conditions: readonly string[],
): string | undefined => {
  const pick = (entry: Exports): string | undefined => {
    if (entry === null || typeof entry === 'string') return entry ?? undefined;
    for (const [condition, next] of Object.entries(entry)) {
      if (!conditions.includes(condition)) continue;
      const target = pick(next);
      if (target) return target;
    }
    return undefined;
  };
  const { exports } = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ) as { exports: Record<string, Exports> };
  const target = pick(exports['.']);
  return target && realpathSync(join(packageDir, target));
};

describe('crypto backend facade', () => {
  it('re-exports every export of the WASM package as the same object', () => {
    const names = Object.keys(real) as (keyof typeof real)[];
    expect(names).toContain('OlmMachine');
    expect(names).toContain('initAsync');
    expect(Object.keys(facade).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(facade[name], name).toBe(real[name]);
    }
  });

  it('hands CommonJS callers the WASM package’s own exports object', () => {
    expect(requireHere(WASM)).toBe(requireHere(`${WASM}-real`));
  });

  it('is what matrix-js-sdk gets for the WASM package name, in CommonJS and ESM', () => {
    const resolved = createRequire(`${sdk}/package.json`).resolve(WASM);
    expect(realpathSync(resolved)).toBe(here('./matrix-sdk-crypto-wasm.cjs'));
    const esm = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `console.log(import.meta.resolve(${JSON.stringify(WASM)}))`,
      ],
      { cwd: sdk, encoding: 'utf8' },
    ).trim();
    expect(realpathSync(fileURLToPath(esm))).toBe(
      here('./matrix-sdk-crypto-wasm.mjs'),
    );
  });

  it('leads a browser bundle from matrix-js-sdk to the WASM package’s browser entry', () => {
    // The conditions a browser build resolves with: no `node`, so the WASM package's index.mjs.
    const browser = ['browser', 'import', 'default'];
    const facadeDir = realpathSync(
      join(sdk, '..', '@matrix-org', 'matrix-sdk-crypto-wasm'),
    );
    expect(exportTarget(facadeDir, browser)).toBe(
      here('./matrix-sdk-crypto-wasm.mjs'),
    );
    const realDir = realpathSync(
      join(
        facadeDir,
        'node_modules',
        '@matrix-org',
        'matrix-sdk-crypto-wasm-real',
      ),
    );
    expect(exportTarget(realDir, browser)).toBe(join(realDir, 'index.mjs'));
  });
});
