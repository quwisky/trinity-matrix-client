import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

const allCodeFiles = globSync(
  ['apps/**/*.ts', 'libs/**/*.ts', 'e2e/**/*.mts'],
  {
    cwd: workspaceRoot,
  },
)
  .filter((file) => !file.startsWith('libs/theme-foundation/'))
  .sort();
const productionCodeFiles = allCodeFiles.filter(
  (file) => !/\.(?:spec|stories)\.[cm]?ts$/u.test(file),
);
const styleFiles = globSync(['apps/**/*.{css,scss}', 'libs/**/*.{css,scss}'], {
  cwd: workspaceRoot,
})
  .filter((file) => !file.startsWith('libs/theme-foundation/styles/'))
  .sort();

const carriesCatalogTriplet = (source, ids) =>
  ids.every((id) =>
    new RegExp(`\\b(?:id|value)\\s*:\\s*['"]${id}['"]`, 'u').test(source),
  );

const definesThemeMetadata = (source, production = true) => {
  const code = stripComments(source);
  if (
    /\bTRINITY_(?:PALETTES|THEME_MODES)\b/u.test(code) ||
    /(?:^|[,{])\s*dataTheme\s*:/mu.test(code)
  ) {
    return true;
  }
  return (
    production &&
    (carriesCatalogTriplet(code, ['system', 'light', 'dark']) ||
      carriesCatalogTriplet(code, ['trinity', 'amethyst', 'onyx']))
  );
};

describe('Theme Foundation repository contract', () => {
  it('makes the application and Storybook consume the supported aggregate', () => {
    const appProject = read('apps/trinity/project.json');
    expect(appProject).toContain('"libs/theme-foundation/styles/theme.scss"');
    expect(appProject).not.toContain('apps/trinity/src/theme/');

    const storybookStyles = read(
      'libs/components/storybook-host/.storybook/global-styles.scss',
    );
    const globalIndex = storybookStyles.indexOf(
      "@use '../../../../apps/trinity/src/global';",
    );
    const themeIndex = storybookStyles.indexOf(
      "@use '../../../theme-foundation/styles/theme';",
    );
    expect(globalIndex).toBeGreaterThanOrEqual(0);
    expect(themeIndex).toBeGreaterThan(globalIndex);
    expect(storybookStyles).not.toContain('apps/trinity/src/theme/');
    expect(storybookStyles).not.toContain('styles/internal/');

    expect(
      existsSync(join(workspaceRoot, 'apps/trinity/src/theme/variables.scss')),
    ).toBe(false);
    expect(
      existsSync(join(workspaceRoot, 'apps/trinity/src/theme/spartan.css')),
    ).toBe(false);
  });

  it('reads non-empty code and style inventories', () => {
    expect(allCodeFiles.length).toBeGreaterThan(100);
    expect(productionCodeFiles.length).toBeGreaterThan(100);
    expect(styleFiles.length).toBeGreaterThan(50);
  });

  it('keeps Theme metadata in Theme Foundation', () => {
    const duplicateMetadata = allCodeFiles.filter((file) =>
      definesThemeMetadata(read(file), productionCodeFiles.includes(file)),
    );
    expect(duplicateMetadata).toEqual([]);
  });

  it('rejects renamed or reshaped copies after stripping comments', () => {
    expect(
      definesThemeMetadata(`
        // const ignored = [{ value: 'system' }, { value: 'light' }, { value: 'dark' }];
        const choices = [
          { value: 'system', label: 'Follow the device' },
          { value: 'light', label: 'Day' },
          { value: 'dark', label: 'Night' },
        ];
      `),
    ).toBe(true);
    expect(
      definesThemeMetadata(`
        // dataTheme: 'comment-only'
        const unrelated = [{ value: 'small' }, { value: 'large' }];
      `),
    ).toBe(false);
  });

  it('keeps root semantic Theme definitions in Theme Foundation', () => {
    const externalDefinitions = styleFiles.filter((file) => {
      const source = stripComments(read(file));
      return (
        /\[data-theme(?:\s*=|\])/u.test(source) ||
        /:root[^{}]*\{[^{}]*--trinity-[a-z0-9-]+\s*:/u.test(source)
      );
    });
    expect(externalDefinitions).toEqual([]);
  });
});
