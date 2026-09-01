import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { THEME_CATALOG } from './theme-catalog';

const projectRoot = join(import.meta.dirname, '../..');
const variablesPath = join(projectRoot, 'styles/internal/variables.scss');

function read(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf8');
}

function declarations(source: string): readonly string[] {
  return [...source.matchAll(/^\s*(--[a-z0-9-]+):/gmu)].map(
    (match) => match[1],
  );
}

describe('Theme Foundation catalog', () => {
  it('is deeply read-only and carries exactly six fixed Theme and Mode previews', () => {
    expect(THEME_CATALOG.defaults).toEqual({
      theme: 'trinity',
      mode: 'system',
    });
    expect(THEME_CATALOG.preview.combinations).toEqual([
      { theme: 'trinity', mode: 'light' },
      { theme: 'trinity', mode: 'dark' },
      { theme: 'amethyst', mode: 'light' },
      { theme: 'amethyst', mode: 'dark' },
      { theme: 'onyx', mode: 'light' },
      { theme: 'onyx', mode: 'dark' },
    ]);
    expect(
      [
        THEME_CATALOG,
        THEME_CATALOG.themes,
        ...THEME_CATALOG.themes,
        THEME_CATALOG.modes,
        ...THEME_CATALOG.modes,
        THEME_CATALOG.defaults,
        THEME_CATALOG.preview,
        THEME_CATALOG.preview.combinations,
        ...THEME_CATALOG.preview.combinations,
        THEME_CATALOG.preview.swatches,
        THEME_CATALOG.authoring,
        THEME_CATALOG.authoring.colorRoles,
        THEME_CATALOG.authoring.elevationRoles,
      ].every(Object.isFrozen),
    ).toBe(true);
  });

  it('keeps resolved CSS values out of TypeScript metadata', () => {
    expect(JSON.stringify(THEME_CATALOG)).not.toMatch(
      /(?:#(?:[0-9a-f]{3})|(?:oklch|hsl|rgb)\()/iu,
    );
  });
});

describe('Theme Foundation stylesheet interface', () => {
  it('keeps the supported aggregate and compatibility entrypoints narrow', () => {
    expect(read('styles/theme.scss')).toContain(
      "@use './internal/variables';\n@use './internal/tailwind-adapter.css';",
    );
    expect(read('../../apps/trinity/src/theme/variables.scss')).toContain(
      "@forward '../../../../libs/theme-foundation/styles/internal/variables';",
    );
    expect(read('../../apps/trinity/src/theme/spartan.css')).toContain(
      "@import '../../../../libs/theme-foundation/styles/internal/tailwind-adapter.css';",
    );
  });

  it('allows named Themes to override governed semantic roles only', () => {
    const source = readFileSync(variablesPath, 'utf8');
    const allowed = new Set([
      ...THEME_CATALOG.authoring.colorRoles,
      ...THEME_CATALOG.authoring.elevationRoles,
    ]);
    const blocks = [
      ...source.matchAll(
        /:root\[data-theme='(?<theme>[^']+)'\](?<mode>:not\(\.dark\)|\.dark)\s*\{(?<body>[\s\S]*?)\n\}/gu,
      ),
    ];

    expect(blocks).toHaveLength((THEME_CATALOG.themes.length - 1) * 2);
    for (const block of blocks) {
      expect(THEME_CATALOG.themes.map(({ id }) => id)).toContain(
        block.groups?.['theme'],
      );
      expect(
        declarations(block.groups?.['body'] ?? '').every((role) =>
          allowed.has(role as never),
        ),
      ).toBe(true);
    }
  });

  it('resolves every governed role from one complete base without Theme chaining', () => {
    const source = readFileSync(variablesPath, 'utf8');
    const base = source.match(/:root\s*\{(?<body>[\s\S]*?)\n\}/u)?.groups?.[
      'body'
    ];
    const baseRoles = new Set(declarations(base ?? ''));

    expect(base).toBeDefined();
    expect(
      [
        ...THEME_CATALOG.authoring.colorRoles,
        ...THEME_CATALOG.authoring.elevationRoles,
      ].every((role) => baseRoles.has(role)),
    ).toBe(true);
    expect(source).not.toMatch(
      /\[data-theme='(?:amethyst|onyx)'\][\s\S]*?var\(--(?:amethyst|onyx)-/u,
    );
  });
});
