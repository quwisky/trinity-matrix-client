import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNLAYERED_RULESET_LEDGER } from './cascade-layer-exceptions.mjs';
import {
  stripMarkupComments,
  stripSourceComments,
  topLevelStyleBlocks,
} from './source-style-blocks.mjs';

/**
 * Freeze the first completed application-consumer migration from #397.
 *
 * Public components still accept a few expansion aliases while the remaining slices move.
 * This guard makes authentication, Trust, startup, routing and host-shell consumers a closed
 * set: comments cannot satisfy it, vendor imports cannot bypass the public tier, and aliases or
 * unlayered component rules cannot quietly return after this slice leaves the migration ledgers.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const migratedRoots = [
  'apps/trinity/src/app',
  'libs/application/runtime/src/lib',
  'libs/feature/auth/src/lib',
  'libs/feature/crypto/src/lib',
  'libs/feature/shell/src/lib',
];
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');
const productionSources = globSync(
  migratedRoots.flatMap((root) => [
    `${root}/**/*.ts`,
    `${root}/**/*.html`,
    `${root}/**/*.scss`,
  ]),
  { cwd: workspaceRoot },
)
  .filter(
    (file) =>
      !file.endsWith('.spec.ts') &&
      !file.endsWith('.stories.ts') &&
      !file.endsWith('test-setup.ts'),
  )
  .sort();
const templates = productionSources.filter((file) => file.endsWith('.html'));
const typescript = productionSources.filter((file) => file.endsWith('.ts'));
const componentStyles = productionSources.filter(
  (file) => file.endsWith('.component.scss') || file.endsWith('.page.scss'),
);

const markup = (file) => stripMarkupComments(read(file));
const source = (file) => stripSourceComments(read(file));
const tags = (selector) =>
  templates.flatMap((file) =>
    [...markup(file).matchAll(selector)].map(([tag]) => [file, tag]),
  );

describe('migrated authentication, Trust and host-shell consumers', () => {
  it('is a non-vacuous public-tier-only production slice', () => {
    expect(productionSources.length).toBeGreaterThan(40);
    expect(templates.length).toBeGreaterThan(10);

    const imports = typescript.flatMap((file) =>
      [...source(file).matchAll(/from\s+['"]([^'"]+)['"]/gu)].map(
        ([, specifier]) => [file, specifier],
      ),
    );
    expect(imports.length).toBeGreaterThan(40);
    expect(
      imports.filter(([, specifier]) =>
        /^(?:@angular\/cdk|@ctrl\/ngx-emoji-mart|@ng-icons|@spartan-ng|@trinity\/helm)/u.test(
          specifier,
        ),
      ),
    ).toEqual([]);
  });

  it('uses only canonical Trinity button, card and overlay vocabulary', () => {
    const buttons = tags(/<(?:button|a)\b[^>]*\btrnBtn\b[^>]*>/gu);
    expect(buttons.length).toBeGreaterThan(25);

    for (const [file, tag] of buttons) {
      expect(tag, file).not.toMatch(
        /\bvariant\s*=\s*['"](?:default|destructive|outline|ghost|link)['"]/u,
      );
      expect(tag, file).not.toMatch(
        /\bsize\s*=\s*['"](?:default|icon(?:-(?:xs|sm|lg))?)['"]/u,
      );
      expect(tag, file).not.toMatch(
        /\bclass\s*=\s*['"][^'"]*(?:bg-|border-|font-|h-|leading-|p[trblxy]?-|ring-|rounded-|shadow-|text-|tracking-|hover:|focus:)[^'"]*['"]/u,
      );
    }

    const cards = tags(/<[^>]*\btrnCard\b[^>]*>/gu);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.any(String),
          expect.stringMatching(/\bvariant="muted"/u),
        ]),
      ]),
    );

    const surfaces = tags(/<[^>]*\btrnOverlaySurface\b[^>]*>/gu);
    expect(surfaces).toHaveLength(2);
    for (const [file, tag] of surfaces) {
      expect(tag, file).toMatch(/\bvariant="neutral"/u);
      expect(tag, file).toMatch(/\bsize="md"/u);
      expect(tag, file).toMatch(/\blayout="dialog"/u);
    }
  });

  it('uses cold finite alert commands and canonical danger variants', () => {
    const authored = typescript.map(source).join('\n');
    expect(authored).toContain('.confirm$(');
    expect(authored).toContain('.prompt$(');
    expect(authored).not.toMatch(/\.(?:confirm|prompt)\s*\(/u);
    expect(authored).not.toMatch(/\bdestructive\s*:\s*true\b/u);
    expect(authored).not.toMatch(/\bvariant\s*:\s*['"]destructive['"]/u);
  });

  it('keeps every component stylesheet in the named components layer', () => {
    expect(componentStyles.length).toBeGreaterThanOrEqual(10);
    for (const file of componentStyles) {
      const blocks = topLevelStyleBlocks(read(file));
      expect(
        blocks.length,
        `${file} must contain authored rules`,
      ).toBeGreaterThan(0);
      expect(
        blocks.map(({ prelude }) => prelude),
        `${file} must emit only named component rules`,
      ).toEqual(Array(blocks.length).fill('@layer components'));
    }

    const migratedExceptions = UNLAYERED_RULESET_LEDGER.filter(([file]) =>
      migratedRoots.some((root) => file.startsWith(`${root}/`)),
    );
    expect(migratedExceptions).toEqual([]);
  });
});
