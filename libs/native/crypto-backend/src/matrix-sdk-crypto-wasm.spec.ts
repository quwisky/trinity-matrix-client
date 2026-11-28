import * as facade from '@matrix-org/matrix-sdk-crypto-wasm';
import * as real from '@matrix-org/matrix-sdk-crypto-wasm-real';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WASM = '@matrix-org/matrix-sdk-crypto-wasm';
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const requireHere = createRequire(import.meta.url);

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

  it('is what matrix-js-sdk gets for the WASM package name', () => {
    // pnpm links the SDK's dependencies beside it, so this is the copy its imports load.
    const sdk = realpathSync(here('../../../../node_modules/matrix-js-sdk'));
    const resolved = createRequire(`${sdk}/package.json`).resolve(WASM);
    expect(realpathSync(resolved)).toBe(here('./matrix-sdk-crypto-wasm.cjs'));
  });
});
