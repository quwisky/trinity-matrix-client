import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withMutantModule } from './mutant-module.mjs';

const root = resolve(import.meta.dirname, '../..');
let fixtures;
let original;
let sibling;
let contract;

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'mutant-module-'));
  await mkdir(join(fixtures, 'nested'));
  sibling = join(fixtures, 'sibling.mjs');
  contract = join(fixtures, 'contract.mjs');
  original = join(fixtures, 'nested/journeys.mjs');
  await writeFile(sibling, "export const name = 'real-sibling';\n");
  await writeFile(contract, "export const rule = 'real-contract';\n");
  await writeFile(original, 'export const unused = 1;\n');
});
afterAll(() => rm(fixtures, { recursive: true, force: true }));

const source = [
  "import { name } from '../sibling.mjs';",
  "import { rule } from '../contract.mjs';",
  'export const seen = [name, rule];',
  '',
].join('\n');

describe('withMutantModule', () => {
  it('writes the mutant outside the scanned e2e tree', async () => {
    await withMutantModule({ original, source }, async (_, { path }) => {
      expect(path.startsWith(join(root, 'node_modules/.cache/'))).toBe(true);
      expect(path.startsWith(join(root, 'e2e'))).toBe(false);
      expect(existsSync(path)).toBe(true);
    });
  });

  it('resolves relative imports to the original siblings', async () => {
    await withMutantModule({ original, source }, async (module) => {
      expect(module.seen).toEqual(['real-sibling', 'real-contract']);
    });
  });

  it('imports a companion mutant instead of the original', async () => {
    await withMutantModule(
      {
        original,
        source,
        companions: {
          [contract]:
            "import { name } from './sibling.mjs';\nexport const rule = `mutant-${name}`;\n",
        },
      },
      async (module) => {
        expect(module.seen).toEqual(['real-sibling', 'mutant-real-sibling']);
      },
    );
  });

  it('removes the directory after success and after a throw', async () => {
    let seen;
    await withMutantModule({ original, source }, (_, { directory }) => {
      seen = directory;
    });
    expect(existsSync(seen)).toBe(false);
    await expect(
      withMutantModule({ original, source }, (_, { directory }) => {
        seen = directory;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(seen)).toBe(false);
  });

  it('rejects a companion that nothing imports', async () => {
    await expect(
      withMutantModule(
        {
          original,
          source: 'export {};\n',
          companions: { [contract]: 'export {};\n' },
        },
        () => undefined,
      ),
    ).rejects.toThrow('never imported');
  });
});
