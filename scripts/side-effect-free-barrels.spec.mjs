import { existsSync, globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from './source-style-blocks.mjs';
import { read, workspaceRoot } from './workspace-sources.mjs';

/**
 * A library whose `package.json` declares `"sideEffects"` (`false`, or the few files that have
 * them) keeps the files the startup bundle doesn't use out of it only while its barrel is made
 * of `export *` lines: esbuild cannot drop Angular's `static {}` component definitions, and one
 * named re-export makes every file the barrel names reachable from `main` again. The build
 * still passes when that happens, so this is the only thing that notices.
 */

const BARREL = './src/index.ts';
const BARREL_LINE = /^export (?:type )?\* from '\.\.?\/[^']+';$/u;

/** Lines of a barrel, comments removed, that are not a relative `export *` or `export type *`. */
function namedBarrelLines(source) {
  return stripSourceComments(source)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !BARREL_LINE.test(line));
}

/** Top-level statements that run on import: a bare `import '…'` or an expression statement. */
function sideEffectStatements(file, source) {
  return ts
    .createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    .statements.filter(
      (statement) =>
        (ts.isImportDeclaration(statement) && !statement.importClause) ||
        ts.isExpressionStatement(statement),
    )
    .map((statement) => statement.getText().split('\n')[0]);
}

// `libs/spartan/*` barrels belong to the `@spartan-ng/cli` generator and are not edited by hand.
const libraries = globSync('libs/**/package.json', {
  cwd: workspaceRoot,
  exclude: ['**/node_modules/**', 'libs/spartan/**'],
})
  .map((file) => ({ root: dirname(file), manifest: JSON.parse(read(file)) }))
  .filter(({ manifest }) => 'sideEffects' in manifest)
  .map(({ root, manifest }) => ({ root, sideEffects: manifest.sideEffects }))
  .sort((a, b) => a.root.localeCompare(b.root));

const listingLibraries = libraries.filter(({ sideEffects }) =>
  Array.isArray(sideEffects),
);

/** Production sources of a library, as `./src/…` paths relative to its root. */
function librarySources(root) {
  return globSync('src/**/*.ts', {
    cwd: join(workspaceRoot, root),
    exclude: [
      'src/**/*.spec.ts',
      'src/**/*.spec-harness.ts',
      'src/**/*.stories.ts',
      'src/test-setup.ts',
    ],
  })
    .map((file) => `./${file}`)
    .sort();
}

describe('side-effect-free barrels', () => {
  it('finds the libraries that declare no side effects', () => {
    // An empty sweep would pass vacuously.
    expect(libraries.map(({ root }) => root)).toEqual(
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

  it.each(libraries.map(({ root }) => root))(
    '%s re-exports with `export *` only',
    (root) => {
      expect(namedBarrelLines(read(`${root}/src/index.ts`))).toEqual([]);
    },
  );

  // esbuild skips a side-effect-free barrel without following its `export *` imports, so a
  // listed file's effect is dropped unless the barrel is listed too.
  it.each(listingLibraries)(
    '$root lists its barrel and only files that exist',
    ({ root, sideEffects }) => {
      expect(sideEffects).toContain(BARREL);
      expect(
        sideEffects.filter(
          (path) => !existsSync(join(workspaceRoot, root, path)),
        ),
      ).toEqual([]);
    },
  );

  it.each(libraries)(
    '$root lists every file with a top-level side effect',
    ({ root, sideEffects }) => {
      const listed = Array.isArray(sideEffects) ? sideEffects : [];
      const unlisted = librarySources(root)
        .filter((path) => !listed.includes(path))
        .flatMap((path) =>
          sideEffectStatements(path, read(join(root, path))).map(
            (statement) => `${path}: ${statement}`,
          ),
        );
      expect(unlisted).toEqual([]);
    },
  );

  describe('barrel detector', () => {
    it.each([
      "export * from './lib/a';",
      "export type * from './lib/a';",
      "export * from '../shared/a';",
      '// A comment naming export { A }.',
      "/* x */ export * from './lib/a';",
      '',
    ])('accepts %j', (source) => {
      expect(namedBarrelLines(source)).toEqual([]);
    });

    it.each([
      "export { A } from './lib/a';",
      "export type { A } from './lib/a';",
      "export * as a from './lib/a';",
      "export * from '@spartan-ng/brain/select';",
      'export {',
      "import { A } from './lib/a';",
      'export const AImports = [A] as const;',
      "/* x */ export { A } from './lib/a';",
    ])('rejects %j', (source) => {
      expect(namedBarrelLines(source)).not.toEqual([]);
    });
  });

  describe('side-effect detector', () => {
    it.each([
      "import 'zone.js';",
      "DOMPurify.addHook('afterSanitizeAttributes', () => undefined);",
      "(globalThis as Record<string, unknown>)['x'] = 1;",
    ])('flags %j', (source) => {
      expect(sideEffectStatements('a.ts', source)).toHaveLength(1);
    });

    it.each([
      "import { A } from './a';",
      "import type { A } from './a';",
      "export const TOKEN = new InjectionToken('t');",
      'export class A {}',
    ])('ignores %j', (source) => {
      expect(sideEffectStatements('a.ts', source)).toEqual([]);
    });
  });
});
