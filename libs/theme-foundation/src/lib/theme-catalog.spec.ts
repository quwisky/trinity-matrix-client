import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { THEME_CATALOG } from './theme-catalog';

const projectRoot = join(import.meta.dirname, '../..');
const workspaceRoot = join(projectRoot, '../..');
const variablesPath = join(projectRoot, 'styles/internal/variables.scss');

function read(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf8');
}

function workspaceFile(path: string): string {
  return readFileSync(join(workspaceRoot, path), 'utf8');
}

function filesBelow(
  directory: string,
  extensions: ReadonlySet<string>,
): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesBelow(path, extensions));
    } else if (extensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      files.push(path);
    }
  }
  return files;
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
  it('keeps the supported aggregate narrow and makes both renderers consume it', () => {
    expect(read('styles/theme.scss')).toContain(
      "@use './internal/variables';\n@use './internal/tailwind-adapter.css';",
    );
    const appProject = workspaceFile('apps/trinity/project.json');
    expect(appProject).toContain('"libs/theme-foundation/styles/theme.scss"');
    expect(appProject).not.toContain('apps/trinity/src/theme/');

    const storybookStyles = workspaceFile(
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

  it('keeps Theme metadata and root semantic Theme definitions in this module', () => {
    const sourceRoots = ['apps', 'libs', 'e2e'].map((path) =>
      join(workspaceRoot, path),
    );
    const codeFiles = sourceRoots
      .flatMap((root) => filesBelow(root, new Set(['.ts', '.mts'])))
      .filter(
        (path) =>
          !relative(workspaceRoot, path).startsWith('libs/theme-foundation/'),
      );
    const duplicateMetadata = codeFiles
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        return (
          /\bTRINITY_(?:PALETTES|THEME_MODES)\b/u.test(source) ||
          /(?:^|[,{])\s*dataTheme\s*:/mu.test(source)
        );
      })
      .map((path) => relative(workspaceRoot, path));

    expect(duplicateMetadata).toEqual([]);

    const styleFiles = sourceRoots
      .flatMap((root) => filesBelow(root, new Set(['.css', '.scss'])))
      .filter(
        (path) =>
          !relative(workspaceRoot, path).startsWith(
            'libs/theme-foundation/styles/',
          ),
      );
    const externalThemeDefinitions = styleFiles
      .filter((path) => {
        const source = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .replace(/\/\/.*$/gmu, '');
        return (
          /\[data-theme(?:\s*=|\])/u.test(source) ||
          /:root[^{}]*\{[^{}]*--trinity-[a-z0-9-]+\s*:/u.test(source)
        );
      })
      .map((path) => relative(workspaceRoot, path));

    expect(externalThemeDefinitions).toEqual([]);
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
    expect(source).not.toMatch(
      /\[data-theme='(?:amethyst|onyx)'\][\s\S]*?var\(--(?:amethyst|onyx)-/u,
    );
  });
});
