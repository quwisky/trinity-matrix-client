import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  stripMarkupComments,
  stripSourceComments,
} from './source-style-blocks.mjs';

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

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
const utilityFiles = globSync(
  ['apps/**/*.{ts,html,css,scss}', 'libs/**/*.{ts,html,css,scss}'],
  { cwd: workspaceRoot },
)
  .filter((file) => !file.startsWith('libs/theme-foundation/styles/'))
  .sort();

const authored = (file) => {
  const source = read(file);
  return file.endsWith('.html')
    ? stripMarkupComments(source)
    : stripSourceComments(source);
};

const violations = (pattern) =>
  utilityFiles.flatMap((file) =>
    [...authored(file).matchAll(pattern)].map(
      ({ 0: token }) => `${file}: ${token}`,
    ),
  );

const carriesCatalogTriplet = (source, ids) =>
  ids.every((id) =>
    new RegExp(`\\b(?:id|value)\\s*:\\s*['"]${id}['"]`, 'u').test(source),
  );

const definesThemeMetadata = (source, production = true) => {
  const code = stripSourceComments(source);
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
    const appStyles = JSON.parse(appProject).targets.build.options.styles;
    expect(appStyles[0]).toBe('libs/theme-foundation/styles/theme.scss');
    expect(appStyles).not.toContain(expect.stringContaining('/internal/'));
    expect(appProject).not.toContain('apps/trinity/src/theme/');

    const storybookStyles = read(
      'libs/components/storybook-host/.storybook/global-styles.scss',
    );
    const cascadeOrder = stripSourceComments(
      read('libs/theme-foundation/styles/internal/tailwind-adapter.css'),
    ).match(/@layer [^;]+;/u)?.[0];
    const appIndex = stripMarkupComments(read('apps/trinity/src/index.html'));
    const storybookPreviewHead = stripMarkupComments(
      read('libs/components/storybook-host/.storybook/preview-head.html'),
    );
    expect(cascadeOrder).toBeDefined();
    expect(appIndex.match(/@layer [^;]+;/u)?.[0]).toBe(cascadeOrder);
    expect(storybookPreviewHead.match(/@layer [^;]+;/u)?.[0]).toBe(
      cascadeOrder,
    );
    const globalIndex = storybookStyles.indexOf(
      "@use '../../../../apps/trinity/src/global';",
    );
    const themeIndex = storybookStyles.indexOf(
      "@use '../../../theme-foundation/styles/theme';",
    );
    expect(themeIndex).toBeGreaterThanOrEqual(0);
    expect(globalIndex).toBeGreaterThan(themeIndex);
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
      const source = stripSourceComments(read(file));
      return (
        /\[data-theme(?:\s*=|\])/u.test(source) ||
        /:root[^{}]*\{[^{}]*--trinity-[a-z0-9-]+\s*:/u.test(source)
      );
    });
    expect(externalDefinitions).toEqual([]);
  });

  it('closes Tailwind colours, elevation and radii to governed roles', () => {
    const adapter = stripSourceComments(
      read('libs/theme-foundation/styles/internal/tailwind-adapter.css'),
    ).replaceAll('\\*', '*');

    expect(adapter).toContain('--color-*: initial;');
    expect(adapter).toContain('--shadow-*: initial;');
    expect(adapter).toContain('--inset-shadow-*: initial;');
    expect(adapter).toContain('--drop-shadow-*: initial;');
    expect(adapter).toContain('--radius-*: initial;');
    expect(adapter).toContain(
      '--color-overlay-scrim: var(--trinity-overlay-scrim);',
    );
    expect(adapter).toContain('--shadow-raised: var(--trinity-shadow-raised);');
    expect(adapter).toContain(
      '--shadow-floating: var(--trinity-shadow-floating);',
    );
    expect(adapter).toContain(
      '--shadow-overlay: var(--trinity-shadow-overlay);',
    );
    expect(
      [...adapter.matchAll(/^\s*--radius-(\*|[a-z0-9-]+):/gmu)].map(
        ([, role]) => role,
      ),
    ).toEqual(['*', 'xs', 'sm', 'md', 'lg', 'xl', 'full']);

    expect(
      violations(
        /\b(?:bg|text|border|ring|outline|fill|stroke|divide|from|via|to)-(?:black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-[0-9]+|\/[0-9]+|\b)/gu,
      ),
    ).toEqual([]);
    expect(violations(/\bshadow-(?:2xs|xs|sm|md|lg|xl|2xl|inner)\b/gu)).toEqual(
      [],
    );
    expect(violations(/\brounded-(?:2xl|3xl|4xl)\b/gu)).toEqual([]);
  });

  it('pins the semantic roles carried by local Helm divergences', () => {
    const expected = [
      [
        'libs/spartan/dropdown-menu/src/lib/hlm-dropdown-menu.ts',
        'shadow-overlay',
        2,
      ],
      [
        'libs/spartan/select/src/lib/hlm-select-content.ts',
        'shadow-overlay',
        1,
      ],
      [
        'libs/spartan/radio-group/src/lib/hlm-radio-indicator.ts',
        'shadow-raised',
        1,
      ],
      ['libs/spartan/tabs/src/lib/hlm-tabs-trigger.ts', 'shadow-raised', 1],
      ['libs/spartan/badge/src/lib/hlm-badge.ts', 'rounded-full', 1],
      ['libs/spartan/avatar/src/lib/hlm-avatar.ts', '--trn-avatar-radius', 4],
    ];

    for (const [file, token, count] of expected) {
      expect(authored(file).split(token).length - 1, file).toBe(count);
    }
  });
});
