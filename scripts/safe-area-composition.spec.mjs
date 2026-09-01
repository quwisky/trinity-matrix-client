import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A `.safe-*` helper and a Tailwind padding utility must not claim the same side.
 *
 * `class="safe-top p-3"` looks like padding plus an inset and is neither. Both helpers now
 * live in `@layer utilities`, so source order chooses one padding declaration and discards the
 * other. The old unlayered contract chose the inset; the classified contract can choose the
 * spacing instead. Either direction loses half the author's intent.
 *
 * This has shipped here twice. All five right-hand panel headers rendered as
 * `padding: 0 0 12px` — a 45px bar with its title flush against the border, beside a 56px
 * room header with a 12px inset (#219). A related layer reversal left the desktop sidebar
 * showing its mobile chevron because a component default beat `md:hidden`; component defaults
 * now live before utilities, and the browser-level cascade probe pins that order.
 *
 * Neither was visible to a unit test: jsdom applies no CSS, so `className` contains exactly
 * the tokens the author wrote and every assertion about it passes. It is decidable from the
 * source, though — the helper's side comes from `global.scss` and the utility's sides come
 * from its prefix — which is what makes it worth a guard rather than another browser test.
 *
 * The composition that IS correct is one declaration doing both, as `.panel-header` and the
 * action sheet's `.sheet` now do: `padding-bottom: calc(0.375rem + env(safe-area-inset-bottom))`.
 * Nothing there can lose a cascade fight, because there is no second rule to lose it to.
 *
 * Validated against the revision that shipped #219: this reports all five panel headers there,
 * and nothing on this tree.
 *
 * ## Two shapes it deliberately does not see
 *
 * **Cross-file composition.** `<trn-x class="safe-bottom">` where `trn-x`'s own host adds
 * `class="p-4"` is the identical cascade fight on the identical element, written in two
 * files. This reads one class list at a time, so it sees two unrelated strings. The wrapper
 * tier makes that reachable, and closing it means resolving host metadata — a different tool.
 *
 * **Variant-gated helpers.** A hypothetical `md:safe-top` paired with `max-md:pt-2` never
 * co-applies, but would be reported. No such usage exists today; if one appears, the fix is
 * to compare variant prefixes rather than to delete the check.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

const GLOBAL_STYLESHEET = 'apps/trinity/src/global.scss';

/** The four physical sides, as the padding longhand each names. */
const SIDES = ['top', 'right', 'bottom', 'left'];

/**
 * Which sides each Tailwind padding utility sets.
 *
 * `ps`/`pe` are logical and resolve against the writing direction; Trinity is LTR
 * throughout (`index.html` sets `lang="en"` and no component flips `dir`), so they are
 * mapped to their physical sides. A future RTL mode would make them both, not neither.
 */
const PADDING_UTILITIES = {
  p: SIDES,
  px: ['left', 'right'],
  py: ['top', 'bottom'],
  pt: ['top'],
  pr: ['right'],
  pb: ['bottom'],
  pl: ['left'],
  ps: ['left'],
  pe: ['right'],
};

/**
 * The `.safe-*` helpers, read from `global.scss` rather than restated.
 *
 * Derived so a sixth helper is covered the day it is written. Deriving the USAGES from the
 * same place would be the mistake — that would compare the file to itself — but the helper
 * set is the other side of the comparison, and reading it is what keeps the guard honest
 * when the helper's side changes.
 */
function safeHelpers() {
  const source = read(GLOBAL_STYLESHEET);
  const helpers = new Map();
  for (const [, name, body] of source.matchAll(
    /\.(safe-[a-z-]+)\s*\{([^}]*)\}/g,
  )) {
    const sides = SIDES.filter((side) =>
      new RegExp(`padding-${side}\\s*:`).test(body),
    );
    if (sides.length) {
      helpers.set(name, sides);
    }
  }
  return helpers;
}

const HELPERS = safeHelpers();

/**
 * Strip Tailwind variant prefixes (`md:`, `hover:`, `max-sm:`) and `!` importance.
 *
 * The `.*` is greedy on purpose: it has to take the LAST colon so that a functional variant
 * carrying one of its own — `supports-[padding:1px]:p-3` — reduces to `p-3` rather than to
 * `1px]:p-3`. The cost is that an arbitrary value containing `://` mangles too
 * (`bg-[url(https://x)]` → `//x)]`), which is harmless here because nothing that survives it
 * can match the padding prefix.
 */
const bare = (token) => token.replace(/^.*:/, '').replace(/^!/, '');

/** Which padding sides a class token sets, if it is a padding utility at all. */
function paddingSides(token) {
  const name = bare(token);
  const prefix = name.match(/^(p[xytrbles]?)-/)?.[1];
  return prefix ? (PADDING_UTILITIES[prefix] ?? []) : [];
}

/**
 * Every class list in the workspace that names a `.safe-*` helper, with where it came from.
 *
 * Templates are read for `class="…"`, and `.ts` files for any quoted string carrying a
 * helper token — `page-header` builds its class list in a ternary in the component, which a
 * template-only sweep cannot see, and that is exactly the file with the live pairing.
 */
function classListsNamingAHelper() {
  const found = [];
  const consider = (file, value, index, source) => {
    const tokens = value.split(/\s+/).filter(Boolean);
    if (!tokens.some((token) => HELPERS.has(bare(token)))) {
      return;
    }
    found.push({
      file,
      line: source.slice(0, index).split('\n').length,
      tokens,
    });
  };

  for (const file of globSync(['libs/**/*.html', 'apps/**/*.html'], {
    cwd: workspaceRoot,
  }).filter((file) => !file.includes('node_modules'))) {
    const source = read(file);
    for (const match of source.matchAll(/class="([^"]*)"/g)) {
      consider(file, match[1], match.index, source);
    }
  }

  for (const file of globSync(['libs/**/*.ts', 'apps/**/*.ts'], {
    cwd: workspaceRoot,
  }).filter(
    (file) => !file.includes('node_modules') && !file.endsWith('.spec.ts'),
  )) {
    const source = read(file);
    for (const match of source.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)) {
      consider(file, match[1] ?? match[2] ?? '', match.index, source);
    }
  }

  return found;
}

const classLists = classListsNamingAHelper();

describe('safe-area helpers and padding utilities', () => {
  it('reads the helpers and their usages, so an empty sweep cannot pass', () => {
    // The helper set, from global.scss.
    expect([...HELPERS.keys()].sort()).toEqual([
      'safe-bottom',
      'safe-left',
      'safe-right',
      'safe-top',
    ]);
    expect(HELPERS.get('safe-top')).toEqual(['top']);
    expect(HELPERS.get('safe-bottom')).toEqual(['bottom']);
    // And the sweep reaches the places that use them, in both file kinds.
    expect(classLists.length).toBeGreaterThanOrEqual(5);
    expect(classLists.some((entry) => entry.file.endsWith('.html'))).toBe(true);
    expect(classLists.some((entry) => entry.file.endsWith('.ts'))).toBe(true);
  });

  it('recognises a padding utility, prefixed or not', () => {
    // The parser is the whole guard: if it stopped matching, every pairing below would
    // score zero overlapping sides and the sweep would pass on a broken tree.
    expect(paddingSides('p-3')).toEqual(SIDES);
    expect(paddingSides('md:px-3')).toEqual(['left', 'right']);
    expect(paddingSides('!pb-1.5')).toEqual(['bottom']);
    expect(paddingSides('p-[3px]')).toEqual(SIDES);
    expect(paddingSides('flex')).toEqual([]);
    expect(paddingSides('pin-3')).toEqual([]);
  });

  it('never pairs a helper with a padding utility on the same side', () => {
    const clashes = [];

    for (const { file, line, tokens } of classLists) {
      for (const token of tokens) {
        const helperSides = HELPERS.get(bare(token));
        if (!helperSides) {
          continue;
        }
        for (const other of tokens) {
          const shared = paddingSides(other).filter((side) =>
            helperSides.includes(side),
          );
          if (shared.length) {
            clashes.push(
              `${file}:${line}: \`${token}\` and \`${other}\` both own ` +
                `${shared.join(', ')} — compose them in one declaration instead`,
            );
          }
        }
      }
    }

    expect(clashes).toEqual([]);
  });

  it('pins the action-sheet base padding and safe area in one declaration', () => {
    // Emulator families are allowed to report a zero bottom inset. A rendered equality on
    // those devices is therefore vacuous: deleting env() would still pass. Keep the exact
    // composition source-guarded, while the installed-WebView journey owns real geometry.
    const source = read(
      'libs/components/overlay/src/lib/action-sheet/trn-action-sheet.component.ts',
    );
    expect(source).toMatch(
      /\.sheet\s*\{\s*padding-bottom:\s*calc\(0\.375rem \+ env\(safe-area-inset-bottom\)\);\s*\}/,
    );
    expect(
      source.match(
        /padding-bottom:\s*calc\(0\.375rem \+ env\(safe-area-inset-bottom\)\);/g,
      ),
    ).toHaveLength(1);
  });
});
