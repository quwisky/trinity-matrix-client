import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every text role must clear WCAG AA against every surface it can actually land on, in every
 * palette x mode combination.
 *
 * The existing measurements in `variables.scss` were done by hand, recorded in a comment, and
 * stop at the base surfaces — which is exactly where the failures are not. A row's text sits
 * on `--trinity-hover` while the pointer is over it and on `--trinity-active` when it is
 * selected, and those two grounds are lighter than the base, so muted text that passes at rest
 * fails the moment you interact with it. A floor that is not executable is a preference.
 *
 * This also makes the palette contract falsifiable: adding a palette is meant to be a data
 * change, and this is what stops a data change from silently shipping unreadable text.
 *
 * The matrix is deliberately built from the FILE rather than from a list maintained here — a
 * new palette is picked up automatically, which is the whole point.
 */

const workspaceRoot = join(import.meta.dirname, '..');
/**
 * Comments are stripped FIRST. `variables.scss` explains the specificity rule using
 * `:root[data-theme='x']` as an example, and reading palettes off the raw text invents a
 * palette called `x` — which then "fails" with a copy of the default palette's ratios.
 */
const source = readFileSync(
  join(workspaceRoot, 'apps/trinity/src/theme/variables.scss'),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/[^\n]*$/gm, '');

/** WCAG AA for body text. Large text may use 3:1; nothing here is guaranteed large. */
const AA = 4.5;

/**
 * Text roles, and the surfaces each one can land on.
 *
 * `--trinity-hover` and `--trinity-active` are in every list on purpose: they are the row
 * grounds, and the reason the hand-measured comments missed today's failures.
 */
const ROLES = [
  {
    text: '--trinity-text',
    on: [
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-rail',
      '--trinity-hover',
      '--trinity-active',
    ],
  },
  {
    text: '--trinity-text-muted',
    on: [
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-rail',
      '--trinity-hover',
      '--trinity-active',
    ],
  },
  {
    text: '--trinity-text-bright',
    on: [
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-hover',
      '--trinity-active',
    ],
  },
  {
    text: '--trinity-danger',
    on: ['--trinity-chat', '--trinity-sidebar', '--trinity-hover'],
  },
  // Accent-coloured text. Deliberately NOT `--trinity-accent`: that is a fill, and a fill and
  // a readable text colour cannot be the same value and both clear AA — blurple is 3.19:1 on
  // the light row grounds. Splitting the role is what makes both assertable.
  {
    text: '--trinity-link',
    on: [
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-rail',
      '--trinity-hover',
      '--trinity-active',
    ],
  },
];

/** Syntax highlighting always renders on the code ground. */
const SYNTAX_ROLES = [
  '--trinity-syntax-plain',
  '--trinity-syntax-keyword',
  '--trinity-syntax-string',
  '--trinity-syntax-number',
  '--trinity-syntax-comment',
  '--trinity-syntax-function',
  '--trinity-syntax-type',
  '--trinity-syntax-variable',
  '--trinity-syntax-punctuation',
];

/** Every `:root…{ }` block in the file, in source order. */
function parseBlocks(css) {
  const blocks = [];
  const pattern = /^(:root[^{]*)\{/gm;
  for (const match of css.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    const body = css.slice(start, i - 1);
    const tokens = new Map();
    for (const [, name, value] of body.matchAll(
      /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g,
    )) {
      tokens.set(
        name,
        value
          .trim()
          .replace(/\s*\/\/.*$/, '')
          .trim(),
      );
    }
    blocks.push({ selector: match[1].trim(), tokens });
  }
  return blocks;
}

const blocks = parseBlocks(source);

/** The palettes present in the file, derived rather than listed. */
const palettes = [
  'trinity',
  ...new Set(
    [...source.matchAll(/\[data-theme='([a-z0-9-]+)'\]/g)].map((m) => m[1]),
  ),
];

/**
 * Resolve a token for one palette x mode, honouring the cascade the selectors encode:
 * defaults first, then dark, then the palette's block for that mode.
 */
function resolve(token, palette, mode, seen = new Set()) {
  if (seen.has(token)) return null; // a var() cycle; nothing to measure
  seen.add(token);
  const applicable = blocks.filter(({ selector }) => {
    const isDark = selector.includes('.dark');
    const themed = /\[data-theme='([a-z0-9-]+)'\]/.exec(selector);
    if (themed && themed[1] !== palette) return false;
    if (!themed && palette !== 'trinity' && isDark !== (mode === 'dark'))
      return false;
    if (isDark && mode !== 'dark') return false;
    if (!isDark && mode === 'dark' && selector.includes(':not(.dark)'))
      return false;
    return true;
  });
  let value = null;
  for (const block of applicable) {
    if (block.tokens.has(token)) value = block.tokens.get(token);
  }
  if (!value) return null;
  const alias = /^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/.exec(value);
  if (alias) return resolve(alias[1], palette, mode, seen);
  return value;
}

/** #rgb / #rrggbb -> [r,g,b], else null (a token we cannot measure is not a failure). */
function toRgb(value) {
  if (!value) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!hex) return null;
  const h =
    hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const luminance = ([r, g, b]) => {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** Every (palette, mode, text, surface) pair that is measurable. */
function* pairs() {
  for (const palette of palettes) {
    for (const mode of ['light', 'dark']) {
      const check = (text, surface) => {
        const fg = toRgb(resolve(text, palette, mode));
        const bg = toRgb(resolve(surface, palette, mode));
        return fg && bg
          ? { palette, mode, text, surface, ratio: ratio(fg, bg) }
          : null;
      };
      for (const role of ROLES) {
        for (const surface of role.on) {
          const pair = check(role.text, surface);
          if (pair) yield pair;
        }
      }
      for (const role of SYNTAX_ROLES) {
        const pair = check(role, '--trinity-rail');
        if (pair) yield pair;
      }
    }
  }
}

const measured = [...pairs()];

describe('contrast matrix', () => {
  it('measures something, so an empty matrix cannot pass as a clean one', () => {
    // A parser change that stopped matching the palette blocks would otherwise report every
    // combination compliant.
    expect(palettes.length).toBeGreaterThanOrEqual(2);
    expect(measured.length).toBeGreaterThan(50);
  });

  it('reproduces a known ratio, so the maths is not merely self-consistent', () => {
    // White on the dark chat ground. Hand-checked against an independent calculator.
    expect(ratio([255, 255, 255], [49, 51, 56])).toBeCloseTo(12.63, 1);
  });

  it('clears WCAG AA for every text role on every surface it lands on', () => {
    const failures = measured
      .filter((m) => m.ratio < AA)
      .map(
        (m) =>
          `${m.palette}/${m.mode}: ${m.text} on ${m.surface} = ${m.ratio.toFixed(2)}:1`,
      )
      .sort();

    expect(failures).toEqual([]);
  });
});
