import { execFileSync } from 'node:child_process';
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
