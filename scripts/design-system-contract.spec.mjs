import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateDesignSystemCatalog } from './design-system-contract.mjs';

const workspaceRoot = join(import.meta.dirname, '..');
const contractCommand = join(
  workspaceRoot,
  'scripts/design-system-contract.mjs',
);
const categories = {
  foundations: [],
  controls: [],
  overlays: [],
  'navigation-layout': [],
  'generic-content': [],
};

const publicComponentRoots = [
  'foundations',
  'controls',
  'generic-content',
  'navigation-layout',
  'overlay',
];

function catalogErrors({ nodes, catalog, paths = {}, read = () => '' }) {
  const errors = [];
  validateDesignSystemCatalog(
    { nodes },
    {
      categories,
      migrationExceptions: [],
      nonConsumable: [],
      proofScreens: [],
      ...catalog,
    },
    paths,
    read,
    errors,
  );
  return errors;
}

function authoredSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return authoredSources(path);
    if (!/\.(?:ts|html)$/u.test(entry.name)) return [];
    if (/\.(?:spec|stories)\.ts$/u.test(entry.name)) return [];
    return [
      readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/<!--[\s\S]*?-->/gu, '')
        .replace(/(^|\s)\/\/.*$/gmu, '$1'),
    ];
  });
}

describe('design-system contract', () => {
  it('validates the public taxonomy and production proof screen', () => {
    const output = execFileSync(process.execPath, [contractCommand], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });

    expect(output).toContain('Design-system contract is valid');
  });

  it('rejects an unclassified public project', () => {
    const errors = catalogErrors({
      nodes: {
        orphan: {
          data: { root: 'libs/components/orphan', tags: ['ui:public'] },
        },
      },
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'classify every ui:public project exactly once',
        ),
      ]),
    );
  });

  it('rejects vendor imports in a proof screen', () => {
    const errors = catalogErrors({
      nodes: {
        proof: { data: { root: 'libs/feature/proof', tags: [] } },
      },
      catalog: {
        proofScreens: [
          {
            project: 'proof',
            source: 'proof.ts',
            template: 'proof.html',
            publicEntrypoints: [],
            requiredSelectors: [],
          },
        ],
      },
      read: (path) =>
        path === 'proof.ts'
          ? "import { HlmButton } from '@trinity/helm/button';"
          : '',
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('imports vendor UI directly'),
      ]),
    );
  });

  it('rejects a vacuous proof-screen sweep', () => {
    const errors = catalogErrors({ nodes: {} });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('must name a production proof screen'),
      ]),
    );
  });

  /** Errors for a `controls` entrypoint whose files are `files`, keyed by workspace path. */
  function controlsEntrypointErrors(files) {
    return catalogErrors({
      nodes: {
        controls: {
          data: { root: 'libs/components/controls', tags: ['ui:public'] },
        },
      },
      catalog: {
        categories: {
          ...categories,
          controls: [
            {
              project: 'controls',
              entrypoint: '@trinity/components/controls',
            },
          ],
        },
      },
      paths: {
        '@trinity/components/controls': [
          './libs/components/controls/src/index.ts',
        ],
      },
      read: (path) => {
        if (path in files) return files[path];
        throw new Error(`ENOENT: ${path}`);
      },
    }).filter((error) => error.includes('public entrypoint'));
  }

  const converted = {
    'libs/components/controls/package.json': '{ "sideEffects": false }',
  };

  it.each([
    "export * from './lib/button';",
    "export type * from './lib/icon';",
  ])('rejects %j from a library that declares no sideEffects', (barrel) => {
    expect(
      controlsEntrypointErrors({
        'libs/components/controls/src/index.ts': barrel,
      }),
    ).toEqual(['controls public entrypoint must use named exports']);
  });

  it('accepts a converted library whose barrel re-exports only its own clean files', () => {
    expect(
      controlsEntrypointErrors({
        ...converted,
        'libs/components/controls/src/index.ts':
          "export * from './lib/button';\nexport type * from './lib/recipe';",
        'libs/components/controls/src/lib/button.ts':
          "import { BrnButton } from '@spartan-ng/brain/button';\nexport { TrnButton } from './trn-button';\nexport const button = BrnButton;",
        'libs/components/controls/src/lib/trn-button.ts':
          'export class TrnButton {}',
        'libs/components/controls/src/lib/recipe.ts':
          'export type Recipe = string;',
      }),
    ).toEqual([]);
  });

  it.each([
    ['the barrel', "export * from '@spartan-ng/brain/select';", ''],
    [
      'a file the barrel lists',
      "export * from './lib/select';",
      "export { BrnSelect } from '@spartan-ng/brain/select';",
    ],
    [
      'a file the barrel lists, by import',
      "export * from './lib/select';",
      "import { BrnSelect } from '@spartan-ng/brain/select';\nexport { BrnSelect };",
    ],
  ])(
    'rejects a package re-export from %s of a converted library',
    (_, barrel, select) => {
      expect(
        controlsEntrypointErrors({
          ...converted,
          'libs/components/controls/src/index.ts': barrel,
          'libs/components/controls/src/lib/select.ts': select,
        }),
      ).toEqual([
        expect.stringContaining(
          'controls public entrypoint must not re-export another package',
        ),
      ]);
    },
  );

  it('keeps retired public styling and Promise compatibility APIs deleted', () => {
    const authored = publicComponentRoots
      .flatMap((root) =>
        authoredSources(join(workspaceRoot, 'libs/components', root, 'src')),
      )
      .join('\n');

    for (const retired of [
      'TrnButtonVariantInput',
      'TrnButtonSizeInput',
      'TrnFieldLabelVariant',
      'TrnPageHeaderVariantInput',
      'TrnIconSizeInput',
      'TrnAvatarSizeInput',
      'TrnBadgeVariantInput',
      'TrnDropdownMenuItemVariantInput',
      'TrnToastVariantInput',
    ]) {
      expect(authored, retired).not.toContain(retired);
    }
    expect(authored).not.toMatch(/\bToastVariant\b/u);
    expect(authored).not.toMatch(/readonly\s+(?:tone|panelClass)\s*=\s*input/u);
    expect(authored).not.toMatch(/role\??\s*:\s*['"]cancel['"]\s*\|/u);
  });

  it('keeps vendor utilities out of every public entrypoint', () => {
    const entrypoints = publicComponentRoots
      .map((root) =>
        readFileSync(
          join(workspaceRoot, 'libs/components', root, 'src/index.ts'),
          'utf8',
        ),
      )
      .join('\n');

    expect(entrypoints).not.toMatch(
      /(?:@trinity\/helm|@spartan-ng|@angular\/cdk|@ng-icons|@ctrl\/ngx-emoji-mart|class-variance-authority|clsx)/u,
    );
  });

  it('ignores imports in comments and rejects selectors found only in comments', () => {
    const errors = catalogErrors({
      nodes: { proof: { data: { root: 'libs/feature/proof', tags: [] } } },
      catalog: {
        proofScreens: [
          {
            project: 'proof',
            source: 'proof.ts',
            template: 'proof.html',
            publicEntrypoints: ['@trinity/components/controls'],
            requiredSelectors: ['<trn-field'],
          },
        ],
      },
      paths: {
        '@trinity/components/controls': [
          './libs/components/controls/src/index.ts',
        ],
      },
      read: (path) =>
        path === 'proof.ts'
          ? "// import { HlmButton } from '@trinity/helm/button';\nimport { TrnButton } from '@trinity/components/controls';"
          : '<!-- <trn-field> -->',
    });

    expect(errors).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('imports vendor UI directly'),
      ]),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing public selector: <trn-field'),
      ]),
    );
  });
});
