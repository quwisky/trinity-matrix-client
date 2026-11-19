import { globSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { read, workspaceRoot } from './workspace-sources.mjs';

/**
 * A library whose `package.json` declares `"sideEffects"` (`false`, or the few files that have
 * them) keeps the files the startup bundle doesn't use out of it only while its barrel is made
 * of `export *` lines: esbuild cannot drop Angular's `static {}` component definitions, and one
 * named re-export makes every file the barrel names reachable from `main` again. The build
 * still passes when that happens, so this is the only thing that notices.
 */

const BARREL_LINE =
  /^(?:\s*|\s*(?:\/\/|\/\*|\*).*|export (?:type )?\* from '[^']+';)$/u;

/** Lines of a barrel that are not `export *`, `export type *`, a comment or blank. */
function namedBarrelLines(source) {
  return source.split('\n').filter((line) => !BARREL_LINE.test(line));
}

// `libs/spartan/*` barrels belong to the `@spartan-ng/cli` generator and are not edited by hand.
const sideEffectFreeLibraries = globSync('libs/**/package.json', {
  cwd: workspaceRoot,
  exclude: ['**/node_modules/**', 'libs/spartan/**'],
})
  .filter((file) => 'sideEffects' in JSON.parse(read(file)))
  .map((file) => dirname(file))
  .sort();

describe('side-effect-free barrels', () => {
  it('finds the libraries that declare no side effects', () => {
    // An empty sweep would pass vacuously.
    expect(sideEffectFreeLibraries).toEqual(
      expect.arrayContaining([
        'libs/components/controls',
        'libs/components/generic-content',
        'libs/components/overlay',
        'libs/data-access/auth',
        'libs/data-access/media',
        'libs/data-access/notifications',
        'libs/data-access/room-administration',
        'libs/data-access/room-library',
        'libs/util/matrix',
      ]),
    );
  });

  it.each(sideEffectFreeLibraries)(
    '%s re-exports with `export *` only',
    (library) => {
      expect(namedBarrelLines(read(`${library}/src/index.ts`))).toEqual([]);
    },
  );

  describe('detector', () => {
    it.each([
      "export * from './lib/a';",
      "export type * from './lib/a';",
      '// A comment naming export { A }.',
      '',
    ])('accepts %j', (line) => {
      expect(namedBarrelLines(line)).toEqual([]);
    });

    it.each([
      "export { A } from './lib/a';",
      "export type { A } from './lib/a';",
      "export * as a from './lib/a';",
      'export {',
      "import { A } from './lib/a';",
      'export const AImports = [A] as const;',
    ])('rejects %j', (line) => {
      expect(namedBarrelLines(line)).toEqual([line]);
    });
  });
});
