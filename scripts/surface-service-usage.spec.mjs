import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `TrnSurfaceService` is the only public way to open a modal surface: feature code says
 * what it opens and never how. The dialog and action-sheet services it wraps stay inside
 * `libs/components/overlay`; this fails on any import of them elsewhere, and on the
 * overlay barrel handing them out again. `dialog-shell-usage` keeps dialogs on the shell.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const internal = /\b(?:TrnDialogService|TrnActionSheetService)\b/u;

/** Whether `source` imports either internal service by name, as a value or a type. */
function importsInternalService(source) {
  return [
    ...source.matchAll(
      /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gu,
    ),
  ].some(([, names]) => internal.test(names));
}

describe('surface service usage', () => {
  it('keeps the wrapped overlay services out of every other library and app', () => {
    const files = globSync(['libs/**/*.ts', 'apps/**/*.ts'], {
      cwd: workspaceRoot,
      exclude: ['libs/components/overlay/**', '**/node_modules/**'],
    });
    // An empty scan would pass vacuously.
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((file) =>
        importsInternalService(readFileSync(join(workspaceRoot, file), 'utf8')),
      )
      .sort();

    expect(offenders).toEqual([]);
  });

  it('does not export them from @trinity/components/overlay', () => {
    const barrel = readFileSync(
      join(workspaceRoot, 'libs/components/overlay/src/index.ts'),
      'utf8',
    );

    expect(barrel).not.toMatch(internal);
    expect(barrel).toMatch(/\bTrnSurfaceService\b/u);
  });

  describe('detector', () => {
    it.each([
      [
        'a named import',
        "import { TrnDialogService } from '@trinity/components/overlay';",
      ],
      [
        'a type import',
        "import type { TrnActionSheetService } from '@trinity/components/overlay';",
      ],
      [
        'an inline type import',
        "import { type TrnDialogService } from '@trinity/components/overlay';",
      ],
      [
        'a multi-line import',
        "import {\n  TrnAlertService,\n  TrnDialogService,\n} from '@trinity/components/overlay';",
      ],
      [
        'a relative import',
        "import { TrnDialogService } from '../dialog/trn-dialog.service';",
      ],
    ])('flags %s', (_, source) => {
      expect(importsInternalService(source)).toBe(true);
    });

    it.each([
      [
        'the surface service',
        "import { TrnSurfaceService } from '@trinity/components/overlay';",
      ],
      ['a comment naming it', '// TrnDialogService used to open this dialog'],
      ['a doc link', '/** Presented via {@link TrnSurfaceService}. */'],
    ])('passes %s', (_, source) => {
      expect(importsInternalService(source)).toBe(false);
    });
  });
});
