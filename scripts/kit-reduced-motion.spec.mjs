import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every kit animation carries its own reduced-motion guard.
 *
 * The vendored Helm components animate with `animate-in` / `animate-out` from
 * `tw-animate-css`, which ships no reduced-motion guard of its own. Three of them —
 * `hlm-select-content`, `hlm-tooltip` and the indeterminate progress bar — used to have no
 * guard either, so for a user who asked for reduced motion, a select panel animating open
 * was stopped only by the blanket `!important` reset in `apps/trinity/src/global.scss`.
 *
 * That blanket is not going away (see the note in `variables.scss`: `tw-animate-css` covers
 * CSS this workspace does not author). So this guard is not about deleting it — it is about
 * each component not DEPENDING on it, which is the difference between a kit file that is
 * correct on its own and one that is correct by accident of what the app happens to load.
 *
 * ## Why a source guard and not a browser test
 *
 * `animate-indeterminate` is only reachable during an upload with no measurable total
 * (`composer-attachment-strip.component.html`), which is expensive and flaky to catch in a
 * real engine for a change with no observable behaviour today. And an e2e that defeated the
 * blanket to isolate the local rule would have to do CSSOM surgery on a bundled stylesheet,
 * pinning the test to the emitted structure of a build artifact.
 *
 * The claim here is decidable from source, which is what makes it worth reading this way —
 * the same family as `kit-state-variants.spec.mjs`.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

/**
 * Source with comments removed.
 *
 * Load-bearing: the divergence banners these guards exist to describe QUOTE the class names
 * they are about, so a sweep over raw text reports every file that documents itself. The
 * first run of this spec did exactly that.
 */
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

const KIT_FILES = globSync('libs/spartan/**/*.ts', { cwd: workspaceRoot })
  .filter(
    (file) => !file.includes('node_modules') && !file.endsWith('.spec.ts'),
  )
  .sort();

/**
 * An `animate-in`/`animate-out` trigger written WITHOUT a `motion-safe:` prefix.
 *
 * Matches the whole variant chain before the utility, so `data-[state=delayed-open]:` and
 * `data-open:` are both seen. A leading `motion-safe:` anywhere in the chain is what makes
 * it guarded — the prefix order Tailwind emits is not significant here.
 */
const BARE_ANIMATE = /(?<![\w:-])((?:[\w[\]=-]+:)*)animate-(?:in|out)\b/g;

function bareTriggers(source) {
  const found = [];
  for (const [match, variants] of source.matchAll(BARE_ANIMATE)) {
    if (!variants.includes('motion-safe:')) {
      found.push(match);
    }
  }
  return found;
}

const THEME = 'apps/trinity/src/theme/spartan.css';

describe('kit animations respect reduced motion', () => {
  it('reads the kit at all, so an empty sweep cannot pass', () => {
    // Without this, a glob that stopped matching would report zero unguarded triggers and
    // this file would go green while guarding nothing.
    expect(KIT_FILES.length).toBeGreaterThan(50);
    const guarded = KIT_FILES.filter((file) =>
      code(file).includes('motion-safe:'),
    );
    expect(guarded.length).toBeGreaterThanOrEqual(3);
  });

  it('never writes a bare animate-in or animate-out', () => {
    const offenders = KIT_FILES.flatMap((file) =>
      bareTriggers(code(file)).map((trigger) => `${file}: ${trigger}`),
    );

    expect(offenders).toEqual([]);
  });

  it('recognises a guarded trigger from an unguarded one', () => {
    // The parser is the guard: if it stopped matching, the sweep above would score zero on
    // a broken tree and pass.
    expect(bareTriggers('data-open:animate-in')).toEqual([
      'data-open:animate-in',
    ]);
    expect(bareTriggers('motion-safe:data-open:animate-in')).toEqual([]);
    expect(bareTriggers('data-[state=delayed-open]:animate-in')).toEqual([
      'data-[state=delayed-open]:animate-in',
    ]);
    expect(bareTriggers('motion-safe:data-closed:animate-out')).toEqual([]);
    expect(bareTriggers('animate-spin')).toEqual([]);
  });

  it('guards the indeterminate progress sweep in the theme', () => {
    // It cannot carry a `motion-safe:` prefix — it is applied through a `[class.…]`
    // binding — so its guard is a rule in the theme instead.
    const theme = read(THEME);
    const guard = theme.match(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.animate-indeterminate \{\s*animation: none;/,
    );

    expect(guard).not.toBeNull();
  });
});
