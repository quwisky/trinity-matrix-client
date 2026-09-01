import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inlineStyleSheets } from './inline-styles.mjs';

/**
 * The application has one cascade and six responsibilities.
 *
 * Angular component styles are still emitted as unlayered runtime style tags. Their complete
 * source inventory is frozen in `styling-idiom.spec.mjs`; this contract treats every inventoried
 * source without an `@layer` as a temporary exception. A new stylesheet or inline block fails
 * that ledger before it can become a silent seventh precedence tier.
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

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/.*$/gmu, '$1');

function ledger(name) {
  const source = read('scripts/styling-idiom.spec.mjs');
  const body = source.match(
    new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`, 'u'),
  )?.[1];
  expect(body, `${name} must remain a literal frozen inventory`).toBeDefined();
  return [...body.matchAll(/'([^']+)'/gu)].map(([, file]) => file);
}

/** Return the outer rule blocks; nested selectors stay inside their owning layer body. */
function topLevelBlocks(source) {
  const css = stripComments(source);
  const blocks = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '{') {
      if (depth === 0) {
        blocks.push({
          prelude: css.slice(start, index).trim(),
          bodyStart: index + 1,
        });
      }
      depth += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        blocks.at(-1).body = css.slice(blocks.at(-1).bodyStart, index);
        start = index + 1;
      }
      continue;
    }
    if (character === ';' && depth === 0) start = index + 1;
  }

  expect(depth, 'stylesheet braces must balance').toBe(0);
  return blocks;
}

const layerBodies = (file, layer) =>
  topLevelBlocks(read(file))
    .filter(({ prelude }) => prelude === `@layer ${layer}`)
    .map(({ body }) => body)
    .join('\n');

describe('cascade layer contract', () => {
  it('declares the one supported order and classifies every static stylesheet', () => {
    const adapter = read(
      'libs/theme-foundation/styles/internal/tailwind-adapter.css',
    );
    expect(
      stripComments(
        read('libs/theme-foundation/styles/internal/cascade-layers.css'),
      ).trim(),
    ).toBe(LAYER_ORDER);
    expect(adapter).toContain(LAYER_ORDER);
    expect(adapter).toContain("@import 'tw-animate-css';");

    expect(
      JSON.parse(read('apps/trinity/project.json')).targets.build.options
        .styles,
    ).toEqual([
      'libs/theme-foundation/styles/internal/cascade-layers.css',
      'libs/theme-foundation/styles/theme.scss',
      'apps/trinity/src/vendor.css',
      'apps/trinity/src/global.scss',
      'apps/trinity/src/rendered-markdown.scss',
    ]);
    expect(stripComments(read('apps/trinity/src/vendor.css')).trim()).toBe(
      "@import '../../../node_modules/@angular/cdk/overlay-prebuilt.css' layer(vendor);\n" +
        "@import '../../../node_modules/@ctrl/ngx-emoji-mart/picker.css' layer(vendor);",
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
      const topLevel = topLevelBlocks(read(file)).map(({ prelude }) => prelude);
      expect(
        topLevel.length,
        `${file} must contain authored rules`,
      ).toBeGreaterThan(0);
      expect(
        new Set(topLevel),
        `${file} has an unclassified top-level rule`,
      ).toEqual(new Set(allowed));
    }
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

  it('freezes every still-unlayered component source as a temporary exception', () => {
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

    const unlayeredComponents = componentSources.filter(
      (file) =>
        !/@layer\s+(?:components|overrides)\b/u.test(stripComments(read(file))),
    );
    expect(unlayeredComponents.length).toBeGreaterThan(50);
    expect(
      unlayeredComponents.every((file) => componentLedger.includes(file)),
    ).toBe(true);

    const inlineSources = inlineStyleSheets();
    const inlineLedger = ledger('INLINE_STYLE_LEDGER');
    expect(inlineSources.map(({ file }) => file)).toEqual(inlineLedger);
    expect(
      inlineSources
        .filter(({ css }) =>
          /@layer\s+(?:components|overrides)\b/u.test(stripComments(css)),
        )
        .map(({ file }) => file),
    ).toEqual([
      'libs/components/overlay/src/lib/action-sheet/trn-action-sheet.component.ts',
    ]);
    const unlayeredInline = inlineSources.filter(
      ({ css }) =>
        !/@layer\s+(?:components|overrides)\b/u.test(stripComments(css)),
    );
    expect(unlayeredInline.length).toBeGreaterThan(5);
    expect(
      unlayeredInline.every(({ file }) => inlineLedger.includes(file)),
    ).toBe(true);
  });

  it('allows only the audited reduced-motion important bridge', () => {
    const declarations = [];
    for (const file of globSync(
      ['apps/**/*.{css,scss}', 'libs/**/*.{css,scss}'],
      {
        cwd: workspaceRoot,
      },
    ).sort()) {
      const source = stripComments(read(file));
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
