/**
 * Colour and cascade machinery for `contrast-matrix.spec.mjs`: parse the stylesheet's `:root`
 * blocks, read the Theme catalog, resolve a token through the cascade and measure contrast.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const catalogSource = readFileSync(
  join(
    import.meta.dirname,
    '..',
    'libs/theme-foundation/src/lib/theme-catalog.ts',
  ),
  'utf8',
);

/** The parsed `:root` blocks `resolve` reads; the spec fills it from its own source text. */
export const blocks = [];

/** Every `:root…{ }` block in the file, in source order. */
export function parseBlocks(css) {
  const blocks = [];
  const pattern = /^\s*(:root[^{]*)\{/gm;
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

export function catalogThemes(sourceText) {
  const body =
    /const themes = Object\.freeze\(\[([\s\S]*?)\] as const satisfies/u.exec(
      sourceText,
    )?.[1];
  if (!body) throw new Error('Missing themes in Theme catalog');
  return [...body.matchAll(/Object\.freeze\(\{([^{}]+)\}\)/gu)].map(
    ([, entry]) => {
      const id = /\bid:\s*'([^']+)'/u.exec(entry)?.[1];
      const dataTheme =
        /\bdataTheme:\s*(?:'([^']+)'|null)/u.exec(entry)?.[1] ?? null;
      if (!id) throw new Error(`Theme catalog entry has no id: ${entry}`);
      return { id, dataTheme };
    },
  );
}

export function catalogRoles(name) {
  const body = new RegExp(
    `const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\] as const\\);`,
    'u',
  ).exec(catalogSource)?.[1];
  if (!body) throw new Error(`Missing ${name} in Theme catalog`);
  return [...body.matchAll(/'(--[^']+)'/gu)].map((match) => match[1]);
}

/**
 * Resolve a token for one theme x mode, honouring the cascade the selectors encode:
 * defaults first, then dark, then the theme's block for that mode.
 */
export function resolve(token, theme, mode, seen = new Set()) {
  if (seen.has(token)) return null; // a var() cycle; nothing to measure
  seen.add(token);
  const applicable = blocks.filter(({ selector }) => {
    // `:not(.dark)` CONTAINS `.dark`, so a substring test calls every light theme block a
    // dark one — applying it in dark mode and skipping it in light, i.e. exactly inverted.
    // Strip the negations before asking.
    const isDark = selector.replace(/:not\([^)]*\)/g, '').includes('.dark');
    const themed = /\[data-theme='([a-z0-9-]+)'\]/.exec(selector);
    if (themed && themed[1] !== theme) return false;
    // NO theme filter on an un-themed block. `:root` applies in EVERY theme — that is
    // what makes it the base — and a filter that dropped it for named themes in dark mode
    // silently unmeasured every role those themes inherit rather than override, which is
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
  if (alias) return resolve(alias[1], theme, mode, seen);
  return value;
}

/**
 * An opaque CSS colour -> [r, g, b], or null if this parser cannot measure it safely.
 *
 * OKLCH, HSL, RGB and hex are all handled so a parser regression cannot silently drop a measured
 * role. Every Theme now authors colours in OKLCH, and the contract below rejects legacy notation.
 * What cannot be parsed is asserted rather than filtered away. Alpha is fail-closed too:
 * discarding it would let transparent text or surfaces report the contrast of invisible channels.
 */
export function toRgb(value) {
  if (!value) return null;
  const text = value.trim();

  const functional = /^(rgba?|hsla?)\((.*)\)$/i.exec(text);
  if (functional) {
    const [, functionName, body] = functional;
    const slashAlpha = /\/\s*([\d.]+)(%)?\s*$/.exec(body);
    const commaParts = body.split(',').map((part) => part.trim());
    const legacyAlpha =
      !slashAlpha && commaParts.length === 4
        ? /^([\d.]+)(%)?$/.exec(commaParts[3])
        : null;
    if (
      (body.includes('/') && !slashAlpha) ||
      (commaParts.length > 3 && !legacyAlpha)
    ) {
      return null;
    }
    const alpha = slashAlpha ?? legacyAlpha;
    if (alpha) {
      const opacity = Number(alpha[1]) / (alpha[2] ? 100 : 1);
      if (opacity !== 1) return null;
    } else if (/a$/i.test(functionName)) {
      return null;
    }
  }

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const h =
      hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  const oklch = parseOklch(text);
  if (oklch) {
    if (oklch.alpha !== 1 || !oklch.inSrgb) return null;
    return oklch.srgb.map((channel) => Math.round(channel * 255));
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

/** Parse one absolute OKLCH value and resolve it through the CSS Color 4 matrices. */
export function parseOklch(value) {
  const match =
    /^oklch\(\s*([\d.]+)(%)?\s+([\d.]+)\s+(-?[\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+)(%)?)?\s*\)$/iu.exec(
      value,
    );
  if (!match) return null;
  const lightness = Number(match[1]) / (match[2] ? 100 : 1);
  const chroma = Number(match[3]);
  const hue = (Number(match[4]) * Math.PI) / 180;
  const alpha = match[5] ? Number(match[5]) / (match[6] ? 100 : 1) : 1;
  if (
    ![lightness, chroma, hue, alpha].every(Number.isFinite) ||
    lightness < 0 ||
    lightness > 1 ||
    chroma < 0 ||
    alpha < 0 ||
    alpha > 1
  ) {
    return null;
  }

  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const epsilon = 0.000_001;
  const inSrgb = linear.every(
    (channel) => channel >= -epsilon && channel <= 1 + epsilon,
  );
  const encode = (channel) =>
    channel <= 0.0031308
      ? 12.92 * channel
      : 1.055 * channel ** (1 / 2.4) - 0.055;
  return {
    alpha,
    inSrgb,
    srgb: linear.map((channel) => encode(Math.min(1, Math.max(0, channel)))),
  };
}

/** The CSS Color spec's hsl-to-rgb, so the two notations agree to the rounded byte. */
export function hslToRgb(hue, saturation, lightness) {
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

export const luminance = ([r, g, b]) => {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

export const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
