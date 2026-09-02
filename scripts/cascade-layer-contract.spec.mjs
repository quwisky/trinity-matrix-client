import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inlineStyleSheets } from './inline-styles.mjs';
import {
  stripMarkupComments,
  stripSourceComments,
  topLevelStyleBlocks,
  topLevelStyleStatements,
} from './source-style-blocks.mjs';

/**
 * The application has one cascade and six responsibilities.
 *
 * Angular emits component styles as runtime style tags, so every authored source must name its
 * layer itself. The complete source inventory is frozen in `styling-idiom.spec.mjs`; this
 * contract rejects any component or inline stylesheet that could become a silent seventh tier.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');
const LAYERS = [
  'theme',
  'base',
  'vendor',
  'components',
  'utilities',
  'overrides',
];
const LAYER_ORDER = `@layer ${LAYERS.join(', ')};`;
const IMPORTANT_DECLARATION =
  /([a-z-]+)\s*:\s*([^;{}]*!important)\s*(?:;|(?=\}))/gu;

function documentStyles() {
  const html = stripMarkupComments(read('apps/trinity/src/index.html'));
  return [...html.matchAll(/<style(?:\s+([^>]*))?>([\s\S]*?)<\/style>/gu)].map(
    ([, attributes = '', body]) => ({ attributes: attributes.trim(), body }),
  );
}

function documentStyle(attribute) {
  const body = documentStyles().find(
    ({ attributes }) => attributes === attribute,
  )?.body;
  expect(body, `index.html must contain <style ${attribute}>`).toBeDefined();
  return body;
}

function ledger(name) {
  const source = stripSourceComments(read('scripts/styling-idiom.spec.mjs'));
  const body = source.match(
    new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`, 'u'),
  )?.[1];
  expect(body, `${name} must remain a literal frozen inventory`).toBeDefined();
  return [...body.matchAll(/'([^']+)'/gu)].map(([, file]) => file);
}

const isComponentLayered = (source) => {
  if (
    !topLevelStyleStatements(source).every((statement) =>
      /^@use\b/u.test(statement),
    )
  )
    return false;
  const blocks = topLevelStyleBlocks(source);
  return (
    blocks.length > 0 &&
    blocks.every(({ prelude }) => prelude === '@layer components')
  );
};

const isNonEmittingPartial = (source) =>
  topLevelStyleStatements(source).every((statement) =>
    /^(?:@use\b|@forward\b|\$[\w-]+\s*:)/u.test(statement),
  ) &&
  topLevelStyleBlocks(source).every(({ prelude }) =>
    /^@(mixin|function)\b/u.test(prelude),
  );

const rulePaths = (source, parents = []) =>
  topLevelStyleBlocks(source).flatMap(({ prelude, body }) => {
    const path = [...parents, prelude.replace(/\s+/gu, ' ')];
    return [path.join(' > '), ...rulePaths(body, path)];
  });

const styleFingerprint = (source) =>
  createHash('sha256')
    .update(stripSourceComments(source).replace(/\s+/gu, ' ').trim())
    .digest('hex');

const layerBodies = (file, layer) =>
  topLevelStyleBlocks(read(file))
    .filter(({ prelude }) => prelude === `@layer ${layer}`)
    .map(({ body }) => body)
    .join('\n');

const resolveSassModule = (owner, specifier) => {
  if (!specifier.startsWith('.')) return specifier;
  const unresolved = resolve(dirname(join(workspaceRoot, owner)), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.scss`,
    join(dirname(unresolved), `_${basename(unresolved)}.scss`),
    join(unresolved, 'index.scss'),
    join(unresolved, '_index.scss'),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  return resolved ? relative(workspaceRoot, resolved) : specifier;
};

const sassModules = (file) =>
  topLevelStyleStatements(read(file))
    .map((statement) => statement.match(/^@(use|forward)\s+['"]([^'"]+)['"]/u))
    .filter(Boolean)
    .map(([, , specifier]) => resolveSassModule(file, specifier));

const sharedPartialConsumers = (partial, componentSources) =>
  componentSources.filter((file) => sassModules(file).includes(partial));

describe('cascade layer contract', () => {
  it('declares the one supported order and classifies every static stylesheet', () => {
    const adapter = stripSourceComments(
      read('libs/theme-foundation/styles/internal/tailwind-adapter.css'),
    );
    expect(documentStyles().map(({ attributes }) => attributes)).toEqual([
      'data-trn-cascade-contract',
      'data-trn-boot-style',
    ]);
    expect(documentStyle('data-trn-cascade-contract').trim()).toBe(LAYER_ORDER);
    expect(
      topLevelStyleStatements(documentStyle('data-trn-boot-style')),
    ).toEqual([]);
    expect(topLevelStyleStatements(adapter)).toEqual([
      LAYER_ORDER.slice(0, -1),
      "@import 'tailwindcss/theme.css' layer(theme)",
      "@import 'tailwindcss/preflight.css' layer(base)",
      "@import 'tailwindcss/utilities.css' layer(utilities)",
      "@import 'tw-animate-css'",
      "@source '../../../../libs'",
      "@source '../../../../apps'",
      '@custom-variant dark (&:where(.dark, .dark *))',
    ]);

    expect(
      JSON.parse(read('apps/trinity/project.json')).targets.build.options
        .styles,
    ).toEqual([
      'libs/theme-foundation/styles/theme.scss',
      'apps/trinity/src/vendor.css',
      'apps/trinity/src/global.scss',
      'apps/trinity/src/rendered-markdown.scss',
    ]);
    expect(
      topLevelStyleStatements(read('libs/theme-foundation/styles/theme.scss')),
    ).toEqual([
      "@use './internal/variables'",
      "@use './internal/tailwind-adapter.css'",
    ]);
    expect(
      topLevelStyleBlocks(read('libs/theme-foundation/styles/theme.scss')),
    ).toEqual([]);
    expect(
      stripSourceComments(read('apps/trinity/src/vendor.css')).trim(),
    ).toBe(
      "@import '../../../node_modules/@angular/cdk/overlay-prebuilt.css' layer(vendor);\n" +
        "@import '../../../node_modules/@ctrl/ngx-emoji-mart/picker.css' layer(vendor);",
    );
    const storybookStyles = stripSourceComments(
      read('libs/components/storybook-host/.storybook/global-styles.scss'),
    );
    expect(
      topLevelStyleStatements(storybookStyles).map((statement) =>
        statement.replace(/\s+/gu, ' '),
      ),
    ).toEqual([
      "@use '../../../theme-foundation/styles/theme'",
      "@use '../../../../apps/trinity/src/global'",
      "@import '../../../../node_modules/@angular/cdk/overlay-prebuilt.css' layer(vendor)",
    ]);
    expect(
      topLevelStyleBlocks(storybookStyles).map(({ prelude }) => prelude),
    ).toEqual(['@layer components']);

    for (const [file, allowed] of [
      [
        'libs/theme-foundation/styles/internal/variables.scss',
        ['@layer theme'],
      ],
      [
        'apps/trinity/src/global.scss',
        [
          '@layer base',
          '@layer components',
          '@layer utilities',
          '@layer overrides',
        ],
      ],
      ['apps/trinity/src/rendered-markdown.scss', ['@layer components']],
    ]) {
      const topLevel = topLevelStyleBlocks(read(file)).map(
        ({ prelude }) => prelude,
      );
      expect(
        topLevel.length,
        `${file} must contain authored rules`,
      ).toBeGreaterThan(0);
      expect(
        new Set(topLevel),
        `${file} has an unclassified top-level rule`,
      ).toEqual(new Set(allowed));
      expect(
        topLevelStyleStatements(read(file)),
        `${file} has an unclassified top-level statement`,
      ).toEqual([]);
    }

    expect(
      topLevelStyleBlocks(documentStyle('data-trn-boot-style')).map(
        ({ prelude }) => prelude,
      ),
    ).toEqual(['@layer components']);
  });

  it('assigns the known precedence reversals to deliberate responsibilities', () => {
    const base = layerBodies('apps/trinity/src/global.scss', 'base');
    expect(base).toContain(
      "textarea:not([data-slot='input'], [data-slot='textarea']):focus-visible",
    );

    const components = layerBodies(
      'apps/trinity/src/global.scss',
      'components',
    );
    expect(components).toContain('router-outlet + *');
    expect(components).toContain('.panel-header');

    const utilities = layerBodies('apps/trinity/src/global.scss', 'utilities');
    expect(utilities).toContain('.safe-top');
    expect(utilities).toContain('.safe-bottom');

    const overrides = layerBodies('apps/trinity/src/global.scss', 'overrides');
    expect(rulePaths(overrides)).toEqual([
      "button:disabled:not([data-trn-selection-locked]), [aria-disabled='true']:not([data-trn-selection-locked])",
      '[data-trn-selection-locked]',
      '[data-trn-action-disabled]',
      ':is(button, a)[data-trn-icon-button]',
      ':is(button, a)[trnBtn][data-trn-icon-button]',
      '@media (hover: hover)',
      "@media (hover: hover) > :is(button, a)[data-trn-icon-button]:not( :disabled, [aria-disabled='true'], [data-disabled='true'], [data-disabled=''] )",
      "@media (hover: hover) > :is(button, a)[data-trn-icon-button]:not( :disabled, [aria-disabled='true'], [data-disabled='true'], [data-disabled=''] ) > &:hover",
      ":is(button, a)[data-trn-icon-button]:not( :disabled, [aria-disabled='true'], [data-disabled='true'], [data-disabled=''] )",
      ":is(button, a)[data-trn-icon-button]:not( :disabled, [aria-disabled='true'], [data-disabled='true'], [data-disabled=''] ) > &:active",
      ":is(button, a)[data-trn-icon-button]:is( :disabled, [aria-disabled='true'], [data-disabled='true'], [data-disabled=''] )",
      '@media (pointer: coarse)',
      '@media (pointer: coarse) > button[data-trn-toggle]',
      '@media (prefers-reduced-motion: reduce)',
      '@media (prefers-reduced-motion: reduce) > *, *::before, *::after',
      '@media (pointer: coarse)',
      "@media (pointer: coarse) > button[trnBtn][data-slot='button'], a[trnBtn][data-slot='button']",
    ]);
    expect(styleFingerprint(overrides)).toBe(
      '08842dda4bb13e91b6bda85351b92ce367faf43cdf774dabe1f5e8212d210fa5',
    );
  });

  it('assigns every authored component ruleset to the components layer', () => {
    expect(
      isComponentLayered(
        "@import './legacy.css'; @layer components { :host { display: block; } }",
      ),
    ).toBe(false);
    expect(
      isComponentLayered(
        "@use './mixins' as mixins; @layer components { :host { display: block; } }",
      ),
    ).toBe(true);
    expect(
      isComponentLayered(
        "@use './mixins' as mixins; @include mixins.rogue; @layer components { :host { display: block; } }",
      ),
    ).toBe(false);
    expect(isNonEmittingPartial('@mixin safe { display: block; }')).toBe(true);
    expect(isNonEmittingPartial('.rogue { display: block; }')).toBe(false);
    expect(isNonEmittingPartial('@include rogue;')).toBe(false);

    const componentSources = globSync(
      [
        'libs/**/*.component.scss',
        'libs/**/*.page.scss',
        'apps/**/*.component.scss',
        'apps/**/*.page.scss',
      ],
      { cwd: workspaceRoot },
    ).sort();
    const componentLedger = ledger('COMPONENT_STYLESHEET_LEDGER');
    expect(componentSources).toEqual(componentLedger);
    const sharedPartials = ledger('SHARED_PARTIALS');

    const inlineSources = inlineStyleSheets();
    const inlineLedger = ledger('INLINE_STYLE_LEDGER');
    expect(inlineSources.map(({ file }) => file)).toEqual(inlineLedger);
    expect(
      inlineSources
        .filter(
          ({ css }) =>
            isComponentLayered(css) &&
            topLevelStyleStatements(css).length === 0,
        )
        .map(({ file }) => file),
    ).toEqual(inlineLedger);

    for (const file of componentSources) {
      expect(isComponentLayered(read(file)), file).toBe(true);
      expect(
        sassModules(file).every((module) => sharedPartials.includes(module)),
        `${file} must use only audited non-emitting Sass modules`,
      ).toBe(true);
    }

    for (const file of sharedPartials) {
      expect(
        isNonEmittingPartial(read(file)),
        `${file} must define only non-emitting Sass helpers`,
      ).toBe(true);
      expect(
        sassModules(file).every((module) => sharedPartials.includes(module)),
        `${file} must use only audited non-emitting Sass modules`,
      ).toBe(true);
      const consumers = sharedPartialConsumers(file, componentSources);
      expect(
        consumers.length,
        `${file} must be consumed by a component stylesheet`,
      ).toBeGreaterThan(0);
      expect(
        consumers.every((consumer) => isComponentLayered(read(consumer))),
        `${file} must emit only through layered consumers`,
      ).toBe(true);
    }
  });

  it('allows only the audited reduced-motion important bridge', () => {
    expect(
      [
        ...':host { color: red !important }'.matchAll(IMPORTANT_DECLARATION),
      ].map(([, property, value]) => `${property}:${value.trim()}`),
    ).toEqual(['color:red !important']);

    const declarations = [];
    const sources = globSync(['apps/**/*.{css,scss}', 'libs/**/*.{css,scss}'], {
      cwd: workspaceRoot,
    })
      .sort()
      .map((file) => [file, read(file)]);
    sources.push(
      ...inlineStyleSheets().map(({ file, css }) => [
        `${file}#inline-styles`,
        css,
      ]),
      ...documentStyles().map(({ attributes, body }) => [
        `apps/trinity/src/index.html#${attributes}`,
        body,
      ]),
    );

    for (const [file, rawSource] of sources) {
      const source = stripSourceComments(rawSource);
      for (const [, property, value] of source.matchAll(
        IMPORTANT_DECLARATION,
      )) {
        declarations.push(`${file}:${property}:${value.trim()}`);
      }
    }

    expect(declarations).toEqual([
      'apps/trinity/src/global.scss:animation-duration:0.01ms !important',
      'apps/trinity/src/global.scss:animation-iteration-count:1 !important',
      'apps/trinity/src/global.scss:transition-duration:0.01ms !important',
      'apps/trinity/src/global.scss:scroll-behavior:auto !important',
    ]);
  });
});
