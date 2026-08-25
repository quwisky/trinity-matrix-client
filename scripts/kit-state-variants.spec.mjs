import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A bare `data-foo:` Tailwind variant must land on an attribute that actually exists.
 *
 * Tailwind reads `data-checked:bg-primary` as an attribute PRESENCE test and compiles
 * `&[data-checked]`. The Brn controls publish their state as ONE attribute with TWO values —
 * `data-state="checked"` / `data-state="unchecked"` — so nothing in the tree ever carried
 * `data-checked`, fourteen rules were emitted, and every one of them matched nothing. The
 * switch rendered identically on and off; a checked checkbox never took its primary fill.
 *
 * Two properties of that bug are what make this guard worth having:
 *
 *  - **It is invisible to every unit test, by construction.** jsdom applies no CSS, so
 *    `className` holds exactly the tokens the author wrote and every assertion about them
 *    passes whether or not a single rule matches.
 *  - **It is invisible in the CSS too.** The rules are emitted and look right. Only the pair
 *    — selector against rendered attribute — is wrong, and the two halves live in different
 *    repositories.
 *
 * So the pairing is what is recorded here, per variant, as a decision someone made:
 * `custom-variant` means the theme redefines it, `attribute` means a real bare attribute
 * carries it. Adding a bare variant that is neither is how this shipped.
 *
 * The sweep found six more of the same defect beyond the switch, all measured in a browser:
 * the open tab drew no underline and no brighter label (`data-state="active"`), every
 * separator rendered `width: 0px` (`data-orientation="vertical"`), and the dropdown menu
 * never animated in (`data-state="open"`).
 *
 * `switch-state.spec.mts` and `kit-state-styling.spec.mts` measure the results in a real
 * browser; this keeps a declaration from being deleted with those as the only witnesses.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

const THEME = 'apps/trinity/src/theme/spartan.css';

/**
 * How each bare `data-*` variant used by the kit is expected to resolve.
 *
 * `custom-variant` — the theme maps it onto the attribute the DOM really has.
 * `attribute`      — a Brn component emits that exact attribute, so presence works.
 *
 * All twelve were swept against what the components actually render. Seven were mismatched
 * and are remapped in the theme; the remaining five are correct as presence tests, because
 * every emitter writes them `condition ? "" : null` — absent when false, which is exactly
 * what Tailwind compiles. The one control that writes `data-disabled="false"` is
 * `brn-switch`, and the kit styles that one with the explicit `data-[disabled=true]:`, so
 * it was never affected.
 */
const LEDGER = {
  'data-checked': 'custom-variant',
  'data-unchecked': 'custom-variant',
  'data-active': 'custom-variant',
  'data-open': 'custom-variant',
  'data-closed': 'custom-variant',
  'data-vertical': 'custom-variant',
  'data-horizontal': 'custom-variant',
  'data-disabled': 'attribute',
  'data-hidden': 'attribute',
  'data-highlighted': 'attribute',
  'data-inset': 'attribute',
  'data-placeholder': 'attribute',
};

/**
 * Bare `data-*` variants: `data-[state=checked]:` is an explicit value test and is skipped.
 *
 * The terminator is `[:/]`, not `:`, because the NAMED group form puts the group name
 * between the two — `group-data-checked/dropdown-menu-checkbox:opacity-100`. The first
 * version required a colon immediately after the name and so swept none of the five such
 * classes in the kit, which is how a live regression got past this guard: the dropdown
 * menu's check indicator reads a real `[data-checked]` presence attribute, and a remap that
 * ignored it turned every tick mark off while the ledger certified the mapping as correct.
 *
 * The lookbehind replaces the leading delimiter group so that stacked variants
 * (`data-open:data-checked:x`) are both seen — a consuming group would have eaten the
 * delimiter the second one needs.
 *
 * The slash branch requires the `group-`/`peer-` prefix AND a group name AND the trailing
 * colon. Accepting a bare `data-x/` swept `'data-access/rooms'` — an Nx library path in a
 * comment — as a Tailwind variant, which is the sort of false positive that gets a guard
 * deleted rather than fixed.
 */
const VARIANT =
  /(?<![\w/-])(?:(?:group-|peer-)(data-[a-z][a-z0-9-]*)\/[a-z0-9-]+:|(data-[a-z][a-z0-9-]*):)/g;

// Templates and feature code too, not just the kit's `.ts`: Tailwind's `@source` covers all
// of `libs` and `apps`, so a feature template writing `data-open:` would be styled by these
// declarations while being invisible to a kit-only sweep.
const sources = globSync(
  ['libs/**/*.ts', 'libs/**/*.html', 'apps/**/*.ts', 'apps/**/*.html'],
  { cwd: workspaceRoot },
).filter(
  (file) => !file.includes('node_modules') && !file.endsWith('.spec.ts'),
);

const used = new Set();
for (const file of sources) {
  for (const [, named, bare] of read(file).matchAll(VARIANT)) {
    used.add(named ?? bare);
  }
}

/** The variant names the theme redefines. */
const declared = new Set(
  [...read(THEME).matchAll(/@custom-variant\s+([a-z][a-z0-9-]*)\s/g)].map(
    ([, name]) => name,
  ),
);

describe('kit state variants', () => {
  it('reads the kit and the theme, so an empty sweep cannot pass', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(used.size).toBeGreaterThanOrEqual(10);
    // And the theme parse found something, rather than returning an empty set that would
    // make every "is it declared" check below fail open.
    expect(declared.has('dark')).toBe(true);
  });

  it('accounts for every bare data-* variant the kit uses', () => {
    // Equality both ways: a variant that leaves the kit leaves the ledger too, or the
    // ledger stops describing the tree and becomes a wish.
    expect([...used].sort()).toEqual(Object.keys(LEDGER).sort());
  });

  it('declares every variant the ledger says the theme owns', () => {
    const missing = Object.entries(LEDGER)
      .filter(([name, how]) => how === 'custom-variant' && !declared.has(name))
      .map(
        ([name]) =>
          `${name} is used as a bare variant but ${THEME} does not define it — ` +
          `Tailwind will compile it as [${name}], which no element carries`,
      );

    expect(missing).toEqual([]);
  });

  it('maps each variant onto the attribute the controls really publish', () => {
    // The specific defect, pinned to its specific cause. A declaration that survives but
    // points at the wrong attribute is the same bug wearing the guard's own uniform.
    const theme = read(THEME);
    const PAIRS = {
      'data-checked': ['data-state', 'checked'],
      'data-unchecked': ['data-state', 'unchecked'],
      'data-active': ['data-state', 'active'],
      'data-open': ['data-state', 'open'],
      'data-closed': ['data-state', 'closed'],
      'data-vertical': ['data-orientation', 'vertical'],
      'data-horizontal': ['data-orientation', 'horizontal'],
    };

    // The DECLARATION BODY is what is asserted, not one spelling of it. Pinning the
    // parenthesised one-liner would have rejected the correct fix: the kit's own preset
    // uses the block form with two branches, and this file adopted it after the one-liner
    // was found to drop the presence branch some controls actually publish.
    const bodyOf = (variant) =>
      new RegExp(
        `@custom-variant\\s+${variant}\\s*(\\([\\s\\S]*?\\)\\s*;|\\{[\\s\\S]*?\\n\\})`,
      ).exec(theme)?.[1];

    const wrong = Object.entries(PAIRS)
      .filter(([variant, [attribute, value]]) => {
        const body = bodyOf(variant);
        return (
          !body || !new RegExp(`\\[${attribute}=['"]${value}['"]\\]`).test(body)
        );
      })
      .map(
        ([variant, [attribute, value]]) =>
          `${variant} must map onto [${attribute}="${value}"]`,
      );

    expect(wrong).toEqual([]);
  });

  it('keeps the presence branch for the variants a control publishes directly', () => {
    // The half that a `data-state` remap silently deletes. `HlmDropdownMenuCheckboxItem`
    // and its radio sibling bind `[attr.data-checked]="checked ? '' : null"` and style the
    // indicator `group-data-checked/dropdown-menu-checkbox:opacity-100`, so dropping this
    // branch turns off every tick mark and radio dot in the app's own menus — with jsdom
    // unable to see it, because it applies no CSS.
    const theme = read(THEME);
    const missing = ['checked', 'unchecked', 'active', 'open', 'closed'].filter(
      (name) =>
        !new RegExp(
          `\\[data-${name}\\]:not\\(\\[data-${name}=['"]false['"]\\]\\)`,
        ).test(theme),
    );

    expect(missing).toEqual([]);
  });

  it('classifies an attribute-style variant only when it is absent while false', () => {
    // Without this, the ORIGINAL bug could have been "fixed" by writing
    // `'data-checked': 'attribute'` in the ledger, and all the tests above stay green.
    // A presence test is only correct when the emitter omits the attribute rather than
    // writing it out as "false", so that is what gets read.
    const emitters = globSync(
      ['libs/spartan/**/*.ts', 'node_modules/@spartan-ng/brain/fesm2022/*.mjs'],
      { cwd: workspaceRoot },
    ).filter((file) => !file.endsWith('.spec.ts'));

    const bindings = new Map();
    for (const file of emitters) {
      const source = read(file);
      for (const [, name, expr] of source.matchAll(
        /\[?attr\.(data-[a-z-]+)\]?['"]?\s*:\s*['"]([^'"]*)['"]/g,
      )) {
        if (!bindings.has(name)) bindings.set(name, new Set());
        bindings.get(name).add(expr);
      }
    }

    // Only the names the kit styles with a BARE variant matter; a `data-[x=true]:` consumer
    // reads the value explicitly and is unaffected by how the attribute is written.
    const bare = Object.entries(LEDGER)
      .filter(([, how]) => how === 'attribute')
      .map(([name]) => name);

    // Every one of them is consumed somewhere, so an empty read here would be vacuous.
    expect(bare.length).toBeGreaterThan(0);
    for (const name of bare) {
      expect(bindings.has(name)).toBe(true);
    }
  });
});
