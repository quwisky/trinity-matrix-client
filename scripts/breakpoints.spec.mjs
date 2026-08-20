import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

/**
 * One breakpoint, three languages.
 *
 * A CSS media query cannot read a custom property — `@media (max-width: var(--x))` is invalid
 * and silently drops the whole block — so a breakpoint physically cannot have one definition
 * the way a colour can. It exists as a Tailwind theme value, as a SCSS variable, and as a
 * matchMedia string in TypeScript, and nothing in the language relates them.
 *
 * That is exactly how the previous state arose: `1100` was written by hand in a template
 * (`max-[1100px]`), in a stylesheet (`@media (max-width: 1100px)`) and in three TypeScript
 * predicates, with no definition anywhere and no way to change it in one place. This file is
 * the relation the languages cannot express — it reads all three and asserts they describe
 * the same pixel.
 *
 * It also asserts the complement convention, because that is the half that fails quietly: a
 * min/max pair written as `768` and `768` leaves a width where both match, and one written as
 * `768` and `767` leaves a fractional width where neither does. Tailwind's own `max-*`
 * variants use `value - 0.02px`, so matching that is what makes `max-members:` and
 * `BELOW_MEMBERS_QUERY` one boundary rather than two a pixel apart.
 */
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

const THEME = 'apps/trinity/src/theme/spartan.css';
const QUERIES = 'libs/util/ui/src/lib/media-query.ts';
const MIXINS = 'libs/feature/rooms/src/lib/styles/_mixins.scss';

/** `--breakpoint-<name>: <n>px;` from the Tailwind theme block. */
function themeBreakpoints() {
  const found = new Map();
  for (const [, name, px] of read(THEME).matchAll(
    /--breakpoint-([a-z0-9-]+):\s*([\d.]+)px\s*;/g,
  )) {
    found.set(name, Number(px));
  }
  return found;
}

/** `export const NAME_QUERY = '(min-width: <n>px)';` from the util lib. */
function tsQueries() {
  const found = new Map();
  for (const [, name, direction, px] of read(QUERIES).matchAll(
    /export const ([A-Z_]+_QUERY)\s*=\s*'\((min|max)-width:\s*([\d.]+)px\)'/g,
  )) {
    found.set(name, { direction, px: Number(px) });
  }
  return found;
}

/**
 * The pairs this workspace maintains: a Tailwind breakpoint name, and the two TypeScript
 * constants that must agree with it. Adding a breakpoint without adding it here is caught by
 * the coverage assertion below, not by silence.
 */
const PAIRS = [
  { theme: 'md', min: 'MD_QUERY', max: 'BELOW_MD_QUERY' },
  { theme: 'members', min: 'MEMBERS_QUERY', max: 'BELOW_MEMBERS_QUERY' },
];

/** Tailwind's own complement offset for `max-*` variants. */
const COMPLEMENT_PX = 0.02;

describe('shell breakpoints', () => {
  it('finds all three definitions at all, so an empty sweep cannot pass as a clean one', () => {
    // Every assertion below is a comparison between two parsed values. A regex that stopped
    // matching would compare undefined with undefined and report agreement.
    expect(themeBreakpoints().size).toBeGreaterThanOrEqual(PAIRS.length);
    expect(tsQueries().size).toBeGreaterThanOrEqual(PAIRS.length * 2);
    expect(read(MIXINS)).toContain('$below-members:');
  });

  it.each(PAIRS)(
    'declares $theme identically in Tailwind and in TypeScript',
    ({ theme, min }) => {
      const declared = themeBreakpoints().get(theme);
      const query = tsQueries().get(min);

      expect(
        declared,
        `--breakpoint-${theme} is not declared in ${THEME}`,
      ).toBeDefined();
      expect(query, `${min} is not exported from ${QUERIES}`).toBeDefined();
      expect(query.direction).toBe('min');
      expect(query.px).toBe(declared);
    },
  );

  it.each(PAIRS)(
    'pairs $theme with a complement that leaves no width matching both or neither',
    ({ min, max }) => {
      const lower = tsQueries().get(min);
      const upper = tsQueries().get(max);

      expect(upper, `${max} is not exported from ${QUERIES}`).toBeDefined();
      expect(upper.direction).toBe('max');
      expect(upper.px).toBeCloseTo(lower.px - COMPLEMENT_PX, 5);
    },
  );

  it('states the members breakpoint identically in SCSS', () => {
    // The one the stylesheet reads. `rooms.page.scss` interpolates this variable rather than
    // writing the number, so this is the only place SCSS can drift from the other two.
    const scss = /\$below-members:\s*'([^']+)'/.exec(read(MIXINS));

    expect(scss, `$below-members is not declared in ${MIXINS}`).not.toBeNull();
    expect(scss[1]).toBe(
      `(max-width: ${tsQueries().get('BELOW_MEMBERS_QUERY').px}px)`,
    );
  });

  it('keeps ad-hoc pixel breakpoints out of everything Tailwind scans', () => {
    // An arbitrary-value variant reads as a local styling choice, so nothing relates it to
    // the stylesheet and the TypeScript using the same number — which is how the duplicated
    // breakpoint got into the markup in the first place. A named variant cannot drift,
    // because it resolves through the theme this file checks.
    //
    // The sweep covers stylesheets as well as templates, and that is not thoroughness for
    // its own sake: Tailwind extracts candidates from the RAW TEXT of every file named by an
    // `@source`, comments included. Describing one of these classes in a CSS comment is
    // enough to emit it, and this repo shipped a dead rule that way — the comment in the
    // theme block explaining what the named breakpoint replaced named the old class, so
    // Tailwind kept generating it.
    const scanned = [
      'libs/**/*.html',
      'apps/**/*.html',
      'libs/**/*.scss',
      'apps/**/*.scss',
      'apps/**/*.css',
    ]
      .flatMap((pattern) => globSync(pattern, { cwd: workspaceRoot }))
      .filter((file) => !file.includes('node_modules'));

    expect(scanned.length).toBeGreaterThan(100);

    const adHoc = scanned.filter((file) =>
      /\b(?:max|min)-\[\d+(?:\.\d+)?px\]:/.test(read(file)),
    );

    expect(adHoc).toEqual([]);
  });
});
