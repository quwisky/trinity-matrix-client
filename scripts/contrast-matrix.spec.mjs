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
  {
    text: '--trinity-state-hover-foreground',
    on: ['--trinity-state-hover-surface'],
  },
  {
    text: '--trinity-state-pressed-foreground',
    on: ['--trinity-state-pressed-surface'],
  },
  {
    text: '--trinity-state-selected-foreground',
    on: ['--trinity-state-selected-surface'],
  },
  {
    text: '--trinity-state-selected-hover-foreground',
    on: ['--trinity-state-selected-hover-surface'],
  },
  {
    text: '--trinity-state-attention-foreground',
    on: ['--trinity-state-attention-surface'],
  },
  {
    text: '--trinity-status-neutral-foreground',
    on: ['--trinity-status-neutral-surface'],
  },
];

/** Focus is a non-text visual indicator, so WCAG's 3:1 component threshold applies. */
const NON_TEXT_ROLES = [
  {
    foreground: '--trinity-focus-ring',
    on: [
      '--trinity-surface-frame',
      '--trinity-surface-navigation',
      '--trinity-surface-workspace',
      '--trinity-surface-raised',
      '--trinity-surface-floating',
      '--trinity-surface-panel',
      '--trinity-state-hover-surface',
      '--trinity-state-pressed-surface',
    ],
  },
  {
    foreground: '--trinity-focus-ring-on-attention',
    on: ['--trinity-state-attention-surface'],
  },
];

/**
 * The Helm/shadcn family, read by the generated components through Tailwind utilities —
 * `text-muted-foreground` alone appears 151 times. They are a separate vocabulary from
 * `--trinity-*` but they render on the same surfaces, so leaving them out measured half the
 * text in the app and called it "every text role".
 */
const HELM_ROLES = [
  {
    text: '--foreground',
    on: [
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-hover',
      '--trinity-active',
    ],
  },
  {
    text: '--muted-foreground',
    on: [
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-hover',
      '--trinity-active',
    ],
  },
  { text: '--card-foreground', on: ['--card'] },
  { text: '--popover-foreground', on: ['--popover'] },
  { text: '--secondary-foreground', on: ['--secondary'] },
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
    // `:not(.dark)` CONTAINS `.dark`, so a substring test calls every light palette block a
    // dark one — applying it in dark mode and skipping it in light, i.e. exactly inverted.
    // Strip the negations before asking.
    const isDark = selector.replace(/:not\([^)]*\)/g, '').includes('.dark');
    const themed = /\[data-theme='([a-z0-9-]+)'\]/.exec(selector);
    if (themed && themed[1] !== palette) return false;
    // NO palette filter on an un-themed block. `:root` applies in EVERY palette — that is
    // what makes it the base — and a filter that dropped it for named palettes in dark mode
    // silently unmeasured every role those palettes inherit rather than override, which is
    // precisely the set most likely to stop working on a new ground. It reported nothing,
    // because `pairs()` discards a pair whose value fails to resolve, and the
    // "can measure every role" guard only catches a value it cannot PARSE, not one it never
    // found. The two lines below are the whole of the mode filter, and always were.
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

/**
 * A CSS colour -> [r, g, b], or null if this parser does not understand the notation.
 *
 * Both notations in use are handled, and that is deliberate rather than incidental: half the
 * token system is authored in `hsl()` (`--foreground`, `--muted-foreground`, `--destructive`)
 * and the `--trinity-*` roles in hex. A parser that quietly returned null for one of them would
 * drop those pairs out of the matrix and still report a clean run — which is why what it cannot
 * parse is asserted below rather than filtered away.
 */
function toRgb(value) {
  if (!value) return null;
  const text = value.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const h =
      hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  // `hsl(240deg 5% 64.9%)` and `hsl(240, 5%, 64.9%)`; `deg` and the commas are optional.
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(
    text,
  );
  if (hsl) {
    return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
  }

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }

  return null;
}

/** The CSS Color spec's hsl-to-rgb, so the two notations agree to the rounded byte. */
function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  const channels =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return channels.map((channel) => Math.round((channel + m) * 255));
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
      for (const role of [...ROLES, ...HELM_ROLES]) {
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

function* nonTextPairs() {
  for (const palette of palettes) {
    for (const mode of ['light', 'dark']) {
      for (const role of NON_TEXT_ROLES) {
        for (const surface of role.on) {
          const foreground = toRgb(resolve(role.foreground, palette, mode));
          const background = toRgb(resolve(surface, palette, mode));
          if (foreground && background) {
            yield {
              palette,
              mode,
              foreground: role.foreground,
              surface,
              ratio: ratio(foreground, background),
            };
          }
        }
      }
    }
  }
}

const measuredNonText = [...nonTextPairs()];

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

  it('can actually measure every role it was given', () => {
    // The failure this closes: `toRgb` returning null drops the pair out of the matrix, so a
    // token written in a notation the parser does not know is not measured AND not reported —
    // the run stays green and the floor quietly stops covering it. Naming the gap is the
    // difference between "these all pass" and "these all pass, as far as I could tell".
    const unmeasurable = [];
    for (const palette of palettes) {
      for (const mode of ['light', 'dark']) {
        for (const role of [...ROLES, ...HELM_ROLES]) {
          for (const token of [role.text, ...role.on]) {
            const value = resolve(token, palette, mode);
            if (value && !toRgb(value)) {
              unmeasurable.push(`${palette}/${mode}: ${token} = ${value}`);
            }
          }
        }
      }
    }

    expect([...new Set(unmeasurable)].sort()).toEqual([]);
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

  it('keeps the focus indicator above the non-text contrast floor on every surface', () => {
    expect(measuredNonText.length).toBe(
      palettes.length *
        2 *
        NON_TEXT_ROLES.reduce((total, role) => total + role.on.length, 0),
    );
    const failures = measuredNonText
      .filter((measurement) => measurement.ratio < 3)
      .map(
        (measurement) =>
          `${measurement.palette}/${measurement.mode}: ${measurement.foreground} on ${measurement.surface} = ${measurement.ratio.toFixed(2)}:1`,
      )
      .sort();

    expect(failures).toEqual([]);
  });
});
