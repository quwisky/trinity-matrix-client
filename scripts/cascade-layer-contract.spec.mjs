import { globSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inlineStyleSheets } from './inline-styles.mjs';
import {
  stripMarkupComments,
  stripSourceComments,
  topLevelStyleBlocks,
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

function documentStyle(attribute) {
  const html = stripMarkupComments(read('apps/trinity/src/index.html'));
  const body = html.match(
    new RegExp(`<style\\s+${attribute}(?:=[^>]*)?>([\\s\\S]*?)<\\/style>`, 'u'),
  )?.[1];
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
  const blocks = topLevelStyleBlocks(source);
  return (
    blocks.length > 0 &&
    blocks.every(({ prelude }) => prelude === '@layer components')
  );
};

const layerBodies = (file, layer) =>
  topLevelStyleBlocks(read(file))
    .filter(({ prelude }) => prelude === `@layer ${layer}`)
    .map(({ body }) => body)
    .join('\n');

const sharedPartialConsumers = (partial, componentSources) =>
  componentSources.filter((file) => {
    const source = stripSourceComments(read(file));
    return [...source.matchAll(/@use\s+['"]([^'"]+)['"]/gu)].some(
      ([, specifier]) => {
        if (!specifier.startsWith('.')) return false;
        const unresolved = resolve(
          dirname(join(workspaceRoot, file)),
          specifier,
        );
        const resolved = relative(
          workspaceRoot,
          join(dirname(unresolved), `_${basename(unresolved)}.scss`),
        );
        return resolved === partial;
      },
    );
  });

describe('cascade layer contract', () => {
  it('declares the one supported order and classifies every static stylesheet', () => {
    const adapter = stripSourceComments(
      read('libs/theme-foundation/styles/internal/tailwind-adapter.css'),
    );
    expect(documentStyle('data-trn-cascade-contract').trim()).toBe(LAYER_ORDER);
    expect(adapter).toContain(LAYER_ORDER);
    expect(adapter).toContain("@import 'tw-animate-css';");

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
      stripSourceComments(read('apps/trinity/src/vendor.css')).trim(),
    ).toBe(
      "@import '../../../node_modules/@angular/cdk/overlay-prebuilt.css' layer(vendor);\n" +
        "@import '../../../node_modules/@ctrl/ngx-emoji-mart/picker.css' layer(vendor);",
    );
    expect(
      stripSourceComments(
        read('libs/components/storybook-host/.storybook/global-styles.scss'),
      ),
    ).toMatch(
      /@import '\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@angular\/cdk\/overlay-prebuilt\.css'\s+layer\(vendor\);/,
    );

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
    expect(overrides).toContain('button:disabled');
    expect(overrides).toContain("[aria-disabled='true']");
    expect(overrides).toContain('[data-trn-action-disabled]');
    expect(overrides).toContain('[data-trn-icon-button]');
    expect(overrides).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('assigns every authored component ruleset to the components layer', () => {
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
        .filter(({ css }) => isComponentLayered(css))
        .map(({ file }) => file),
    ).toEqual(inlineLedger);

    for (const file of componentSources) {
      expect(isComponentLayered(read(file)), file).toBe(true);
    }

    for (const file of sharedPartials) {
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
    );

    for (const [file, rawSource] of sources) {
      const source = stripSourceComments(rawSource);
      for (const [, property, value] of source.matchAll(
        /([a-z-]+)\s*:\s*([^;{}]*!important)\s*;/gu,
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
