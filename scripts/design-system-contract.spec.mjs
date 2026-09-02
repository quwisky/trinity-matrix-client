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
    const errors = [];
    validateDesignSystemCatalog(
      {
        nodes: {
          orphan: {
            data: { root: 'libs/components/orphan', tags: ['ui:public'] },
          },
        },
      },
      {
        categories,
        migrationExceptions: [],
        nonConsumable: [],
        proofScreens: [],
      },
      {},
      () => '',
      errors,
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'classify every ui:public project exactly once',
        ),
      ]),
    );
  });

  it('rejects vendor imports in a proof screen', () => {
    const errors = [];
    validateDesignSystemCatalog(
      {
        nodes: {
          proof: { data: { root: 'libs/feature/proof', tags: [] } },
        },
      },
      {
        categories,
        migrationExceptions: [],
        nonConsumable: [],
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
      {},
      (path) =>
        path === 'proof.ts'
          ? "import { HlmButton } from '@trinity/helm/button';"
          : '',
      errors,
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('imports vendor UI directly'),
      ]),
    );
  });

  it('rejects a vacuous proof-screen sweep', () => {
    const errors = [];
    validateDesignSystemCatalog(
      { nodes: {} },
      {
        categories,
        migrationExceptions: [],
        nonConsumable: [],
        proofScreens: [],
      },
      {},
      () => '',
      errors,
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('must name a production proof screen'),
      ]),
    );
  });

  it('rejects broad exports from a public entrypoint', () => {
    const errors = [];
    validateDesignSystemCatalog(
      {
        nodes: {
          controls: {
            data: {
              root: 'libs/components/controls',
              tags: ['ui:public'],
            },
          },
        },
      },
      {
        categories: {
          ...categories,
          controls: [
            {
              project: 'controls',
              entrypoint: '@trinity/components/controls',
            },
          ],
        },
        migrationExceptions: [],
        nonConsumable: [],
        proofScreens: [],
      },
      {
        '@trinity/components/controls': [
          './libs/components/controls/src/index.ts',
        ],
      },
      () => "export * from './lib/button';",
      errors,
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('public entrypoint must use named exports'),
      ]),
    );
  });

  it('rejects broad type-only exports from a public entrypoint', () => {
    const errors = [];
    validateDesignSystemCatalog(
      {
        nodes: {
          foundations: {
            data: {
              root: 'libs/components/foundations',
              tags: ['ui:public'],
            },
          },
        },
      },
      {
        categories: {
          ...categories,
          foundations: [
            {
              project: 'foundations',
              entrypoint: '@trinity/components/foundations',
            },
          ],
        },
        migrationExceptions: [],
        nonConsumable: [],
        proofScreens: [],
      },
      {
        '@trinity/components/foundations': [
          './libs/components/foundations/src/index.ts',
        ],
      },
      () => "export type * from './lib/icon';",
      errors,
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('public entrypoint must use named exports'),
      ]),
    );
  });

  it('keeps retired public styling and Promise compatibility APIs deleted', () => {
    const authored = publicComponentRoots
      .flatMap((root) =>
        authoredSources(join(workspaceRoot, 'libs/components', root, 'src')),
      )
      .join('\n');

    for (const retired of [
      'TrnButtonVariantInput',
      'TrnButtonSizeInput',
      'TrnToggleVariantInput',
      'TrnToggleSizeInput',
      'TrnFieldLabelVariant',
      'TrnTabsVariantInput',
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
    const errors = [];
    validateDesignSystemCatalog(
      { nodes: { proof: { data: { root: 'libs/feature/proof', tags: [] } } } },
      {
        categories,
        migrationExceptions: [],
        nonConsumable: [],
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
      {
        '@trinity/components/controls': [
          './libs/components/controls/src/index.ts',
        ],
      },
      (path) =>
        path === 'proof.ts'
          ? "// import { HlmButton } from '@trinity/helm/button';\nimport { TrnButton } from '@trinity/components/controls';"
          : '<!-- <trn-field> -->',
      errors,
    );

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
