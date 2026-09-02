import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { THEME_CATALOG, themePreviewCombinations } from './theme-catalog';

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

interface ThemeBlock {
  readonly selector: string;
  readonly body: string;
}

const ASSET_VALUE_FUNCTION =
  /\b(?:cross-fade|element|image|(?:-webkit-)?image-set|paint|url)\s*\(/iu;

function themeBlocks(source: string): readonly ThemeBlock[] {
  const blocks: ThemeBlock[] = [];
  const selectors = source.matchAll(
    /(?<selector>[^{}]*\[data-theme(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\]\s]+))?\][^{}]*)\s*\{/gu,
  );

  for (const match of selectors) {
    const openBrace = (match.index ?? 0) + match[0].lastIndexOf('{');
    let depth = 1;
    let cursor = openBrace + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1;
      if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) throw new Error(`Unclosed Theme block: ${match[0]}`);

    blocks.push({
      selector: match.groups?.['selector']?.trim() ?? '',
      body: source.slice(openBrace + 1, cursor - 1),
    });
  }

  return blocks;
}

function authoredStatements(body: string): readonly string[] {
  return body
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe('Theme Foundation catalog', () => {
  it('is deeply read-only and carries every fixed Theme and Mode preview', () => {
    expect(THEME_CATALOG.defaults).toEqual({
      theme: 'trinity',
      mode: 'system',
    });
    const fixedModes = THEME_CATALOG.modes.filter(
      ({ previewClass }) => previewClass !== null,
    );
    expect(THEME_CATALOG.preview.combinations).toHaveLength(
      THEME_CATALOG.themes.length * fixedModes.length,
    );
    for (const { id: theme } of THEME_CATALOG.themes) {
      for (const { id: mode } of fixedModes) {
        expect(THEME_CATALOG.preview.combinations).toContainEqual({
          theme,
          mode,
        });
      }
    }
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

  it('derives previews for a sparse synthetic Theme from metadata alone', () => {
    const syntheticTheme = Object.freeze({
      id: 'contract-proof',
      label: 'Contract proof',
      dataTheme: 'contract-proof',
    });

    const previews = themePreviewCombinations(
      [...THEME_CATALOG.themes, syntheticTheme],
      THEME_CATALOG.modes,
    );

    expect(previews.filter(({ theme }) => theme === syntheticTheme.id)).toEqual(
      [
        { theme: 'contract-proof', mode: 'light' },
        { theme: 'contract-proof', mode: 'dark' },
      ],
    );
  });

  it('keeps resolved CSS values out of TypeScript metadata', () => {
    expect(JSON.stringify(THEME_CATALOG)).not.toMatch(
      /(?:#(?:[0-9a-f]{3})|(?:oklch|hsl|rgb)\()/iu,
    );
  });
});

describe('Theme Foundation stylesheet interface', () => {
  it('keeps the supported aggregate narrow', () => {
    expect(read('styles/theme.scss')).toContain(
      "@use './internal/variables';\n@use './internal/tailwind-adapter.css';",
    );
  });

  it('allows named Themes to override governed semantic roles only', () => {
    const source = readFileSync(variablesPath, 'utf8');
    const authoredSource = source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\/\/.*$/gmu, '');
    const allowed = new Set([
      ...THEME_CATALOG.authoring.colorRoles,
      ...THEME_CATALOG.authoring.elevationRoles,
    ]);
    const blocks = themeBlocks(authoredSource);
    const expectedSelectors = THEME_CATALOG.themes.flatMap(({ dataTheme }) =>
      dataTheme === null
        ? []
        : [
            `:root[data-theme='${dataTheme}']:not(.dark)`,
            `:root[data-theme='${dataTheme}'].dark`,
          ],
    );

    expect(blocks.map(({ selector }) => selector)).toEqual(expectedSelectors);
    for (const block of blocks) {
      const statements = authoredStatements(block.body);
      expect(block.body).not.toMatch(ASSET_VALUE_FUNCTION);
      expect(
        statements.every((statement) =>
          /^--[a-z0-9-]+\s*:[^{}]+$/u.test(statement),
        ),
      ).toBe(true);
      expect(
        statements
          .map((statement) => statement.match(/^(--[a-z0-9-]+)\s*:/u)?.[1])
          .every((role) => role !== undefined && allowed.has(role as never)),
      ).toBe(true);
    }
  });

  it('discovers alternate Theme selector syntax and asset functions for rejection', () => {
    const bypassAttempts = `
      :root[data-theme="amethyst"] .component { font-family: serif; }
      @media (width > 1px) {
        :root[data-theme=onyx] { --trinity-accent: image-set("asset.png" 1x); }
      }
    `;

    expect(themeBlocks(bypassAttempts).map(({ selector }) => selector)).toEqual(
      [':root[data-theme="amethyst"] .component', ':root[data-theme=onyx]'],
    );
    expect(bypassAttempts).toMatch(ASSET_VALUE_FUNCTION);
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
    for (const { dataTheme } of THEME_CATALOG.themes) {
      if (dataTheme === null) continue;
      expect(source).not.toMatch(
        new RegExp(
          `\\[data-theme='${dataTheme}'\\][\\s\\S]*?var\\(--${dataTheme}-`,
          'u',
        ),
      );
    }
  });
});
