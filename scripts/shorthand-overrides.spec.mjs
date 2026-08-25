import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inlineStyleSheets } from './inline-styles.mjs';

/**
 * A shorthand must not silently undo a longhand set earlier in the same file.
 *
 * `background: red` does not mean "set the background colour". It means "set every
 * background longhand, and reset the ones I did not mention" — so a `background-size`
 * declared in an earlier rule of equal specificity is gone, with nothing in either rule to
 * suggest it. `font`, `transition`, `animation`, `border`, `flex` and the rest behave the
 * same way.
 *
 * This has already shipped here. `background-size: 100% 100%` for the blurhash placeholder
 * was declared above `.media--image { background: … }`, so every decoded placeholder tiled
 * as a 32x32 mosaic instead of stretching to the box. The URL was correct throughout, and
 * the end-to-end test asserted the URL.
 *
 * `stylelint`'s `declaration-block-no-shorthand-property-overrides` catches this WITHIN one
 * block and cannot see across rules, which is where it actually happens.
 *
 * The overlap test is deliberately strict: the later rule must name a class the earlier rule
 * also names, so `.a` after `.a, .b` counts and `.a` after `.c` does not. That is precise
 * enough to have zero false positives on this tree while still catching the real case, which
 * is what keeps a guard like this alive.
 *
 * The corpus is every stylesheet AND every inline `styles: [...]` array, because the rule is
 * about CSS rather than about files: ten wrapper components declare their rules on the
 * component, and reading `.scss` alone left all of them unswept.
 *
 * Validated against the revision that shipped the mosaic: two hits there, none now.
 */

const workspaceRoot = join(import.meta.dirname, '..');

/** Longhands each shorthand silently re-initialises when it does not mention them. */
const SHORTHANDS = {
  background: [
    'background-size',
    'background-repeat',
    'background-position',
    'background-image',
    'background-attachment',
    'background-clip',
    'background-origin',
  ],
  font: [
    'font-size',
    'font-weight',
    'font-family',
    'line-height',
    'font-style',
  ],
  transition: [
    'transition-duration',
    'transition-property',
    'transition-timing-function',
    'transition-delay',
  ],
  animation: [
    'animation-duration',
    'animation-iteration-count',
    'animation-timing-function',
    'animation-delay',
    'animation-name',
  ],
  border: ['border-width', 'border-style', 'border-color'],
  outline: ['outline-width', 'outline-style', 'outline-color'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
};

const strip = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** Top-level rules in source order, each with its full brace-matched body. */
function rulesOf(text) {
  const found = [];
  const opener = /(^|\})\s*([^{}@]+?)\{/gm;
  let match;
  while ((match = opener.exec(text))) {
    const selector = match[2].trim();
    if (!selector) {
      continue;
    }
    const start = opener.lastIndex;
    let depth = 1;
    let end = start;
    while (end < text.length && depth > 0) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}') depth--;
      if (depth > 0) end++;
    }
    found.push({ selector, body: text.slice(start, end) });
  }
  return found;
}

/**
 * The class tokens a selector list mentions: `.a, .b .c` -> {.a, .b, .c}
 *
 * Pseudo-classes and pseudo-elements are stripped, because they do not change WHICH element
 * the rule lands on — only when. Leaving them attached made `.x:hover` a different token
 * from `.x`, so the commonest shape of the bug this file exists to catch, a base rule and
 * its own hover, scored zero shared classes and went unreported.
 */
const classesOf = (selector) =>
  new Set(
    selector
      .split(',')
      .flatMap((part) => part.trim().split(/[\s>+~]+/))
      .filter((token) => token.startsWith('.'))
      .map((token) => token.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '')),
  );

/**
 * Class pairs that some template puts on the SAME element.
 *
 * The other half of the miss. `.media { background-size } .media--image { background }` is
 * the identical defect to writing both on one selector — every element is
 * `class="media media--image"`, the specificities tie and the later rule wins — but the two
 * rules share no class token, so a name-equality test cannot see it. The markup is what
 * relates them, so the markup is what is read.
 *
 * Restricted to pairs where BOTH classes are styled somewhere in the corpus: templates are
 * full of Tailwind utilities, and pairing those with everything would swamp the comparison
 * with elements no component stylesheet targets.
 */
function coOccurringClasses(files, styled) {
  const pairs = new Map();
  const add = (a, b) => {
    if (!pairs.has(a)) pairs.set(a, new Set());
    pairs.get(a).add(b);
  };
  for (const file of files) {
    const source = readFileSync(join(workspaceRoot, file), 'utf8');
    for (const [, value] of source.matchAll(/class="([^"]*)"/g)) {
      const names = value
        .split(/\s+/)
        .filter(Boolean)
        .map((name) => `.${name}`)
        .filter((name) => styled.has(name));
      for (const a of names) {
        for (const b of names) {
          if (a !== b) add(a, b);
        }
      }
    }
  }
  return pairs;
}

const declares = (body, property) =>
  new RegExp(`(^|[;{\\s])${property}\\s*:`).test(body);

/** Every source of CSS in the tree, as `{ label, text }` — a file, or a component's array. */
const sheets = [
  ...globSync(['libs/**/*.scss', 'apps/**/*.scss', 'apps/**/*.css'], {
    cwd: workspaceRoot,
  })
    .filter((file) => !file.includes('node_modules'))
    .map((file) => ({
      label: file,
      text: strip(readFileSync(join(workspaceRoot, file), 'utf8')),
    })),
  ...inlineStyleSheets().map(({ file, css }) => ({
    label: `${file} (inline styles)`,
    text: strip(css),
  })),
];

/** Every class token any rule in the corpus targets. */
const styledClasses = new Set(
  sheets.flatMap(({ text }) =>
    rulesOf(text).flatMap((rule) => [...classesOf(rule.selector)]),
  ),
);

const templateFiles = ['libs/**/*.html', 'apps/**/*.html']
  .flatMap((pattern) => globSync(pattern, { cwd: workspaceRoot }))
  .filter((file) => !file.includes('node_modules'));

const coOccurring = coOccurringClasses(templateFiles, styledClasses);

/** Do these two selectors land on the same element — by name, or by the markup? */
const overlaps = (earlier, later) =>
  [...later].filter(
    (token) =>
      earlier.has(token) ||
      [...(coOccurring.get(token) ?? [])].some((mate) => earlier.has(mate)),
  );

describe('shorthand overrides', () => {
  it('reads the stylesheets at all, so an empty sweep cannot pass', () => {
    expect(sheets.length).toBeGreaterThan(50);
    // Including the inline idiom, which was invisible to this guard entirely.
    expect(
      sheets.filter(({ label }) => label.endsWith('(inline styles)')).length,
    ).toBeGreaterThanOrEqual(10);
    // And the parser finds rules in them, rather than returning nothing on every file.
    const parsed = sheets.reduce(
      (total, { text }) => total + rulesOf(text).length,
      0,
    );
    expect(parsed).toBeGreaterThan(200);
  });

  it('never lets a later shorthand reset an earlier longhand', () => {
    const resets = [];

    for (const { label, text } of sheets) {
      const rules = rulesOf(text);
      for (let i = 0; i < rules.length; i++) {
        for (const [shorthand, longhands] of Object.entries(SHORTHANDS)) {
          const set = longhands.filter((longhand) =>
            declares(rules[i].body, longhand),
          );
          if (!set.length) {
            continue;
          }
          const earlier = classesOf(rules[i].selector);
          for (let j = i + 1; j < rules.length; j++) {
            if (!declares(rules[j].body, shorthand)) {
              continue;
            }
            const shared = overlaps(earlier, classesOf(rules[j].selector));
            if (!shared.length) {
              continue;
            }
            resets.push(
              `${label}: "${rules[j].selector.replace(/\s+/g, ' ')}" sets \`${shorthand}\`, ` +
                `resetting ${set.join(', ')} from "${rules[i].selector.replace(/\s+/g, ' ')}" on ${shared.join(', ')}`,
            );
          }
        }
      }
    }

    expect(resets).toEqual([]);
  });
});
