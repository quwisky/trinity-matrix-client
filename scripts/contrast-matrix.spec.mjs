import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blocks,
  catalogSource,
  catalogRoles,
  catalogThemes,
  hslToRgb,
  luminance,
  parseBlocks,
  parseOklch,
  ratio,
  resolve,
  toRgb,
} from './contrast-matrix.mjs';

/**
 * Every text role must clear WCAG AA against every surface it can actually land on, in every
 * theme x mode combination.
 *
 * The existing measurements in `variables.scss` were done by hand, recorded in a comment, and
 * stop at the base surfaces — which is exactly where the failures are not. A row's text sits
 * on `--trinity-hover` while the pointer is over it and on `--trinity-active` when it is
 * selected, and those two grounds are lighter than the base, so muted text that passes at rest
 * fails the moment you interact with it. A floor that is not executable is a preference.
 *
 * This also makes the theme contract falsifiable: adding a theme is meant to be a data
 * change, and this is what stops a data change from silently shipping unreadable text.
 *
 * The matrix is deliberately built from the FILE rather than from a list maintained here — a
 * new theme is picked up automatically, which is the whole point.
 */

const workspaceRoot = join(import.meta.dirname, '..');
/**
 * Comments are stripped FIRST. `variables.scss` explains the specificity rule using
 * `:root[data-theme='x']` as an example, and reading themes off the raw text invents a
 * theme called `x` — which then "fails" with a copy of the default theme's ratios.
 */
const productionSource = readFileSync(
  join(workspaceRoot, 'libs/theme-foundation/styles/internal/variables.scss'),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/[^\n]*$/gm, '');

/**
 * A deliberately sparse Theme used as a shipping-contract proof. It has only metadata plus
 * one semantic override per mode; every other role must inherit from the complete base.
 * Keeping it in the guard rather than the product catalog proves a fourth Theme needs no
 * component, vendor or application edits.
 */
const SYNTHETIC_THEME = Object.freeze({
  id: 'contract-proof',
  label: 'Contract proof',
  dataTheme: 'contract-proof',
});
const SYNTHETIC_THEME_CSS = `
    :root[data-theme='${SYNTHETIC_THEME.dataTheme}']:not(.dark) {
      --trinity-link: oklch(47% 0.19 275deg);
    }

    :root[data-theme='${SYNTHETIC_THEME.dataTheme}'].dark {
      --trinity-link: oklch(76% 0.105 275deg);
    }
  `;

const source = `${productionSource}\n${SYNTHETIC_THEME_CSS}`;

/** WCAG AA for body text. Large text may use 3:1; nothing here is guaranteed large. */
const AA = 4.5;

const PANE_GROUNDS = [
  '--trinity-surface-overlay',
  '--trinity-surface-overlay-footer',
  '--trinity-chat',
  '--trinity-surface-floating-card',
  '--trinity-sidebar',
  '--trinity-surface-sidebar',
  '--trinity-rail',
  '--trinity-hover',
  '--trinity-active',
];

/**
 * Text roles, and the surfaces each one can land on.
 *
 * `--trinity-hover` and `--trinity-active` are in every list on purpose: they are the row
 * grounds, and the reason the hand-measured comments missed today's failures.
 */
const ROLES = [
  {
    text: '--trinity-text',
    on: PANE_GROUNDS,
  },
  // A solid secondary row's label on the neutral fill (`trnBtn shape="row"`), at rest and hovered.
  {
    text: '--trinity-control-secondary-foreground',
    on: [
      '--trinity-neutral-fill-surface',
      '--trinity-neutral-fill-hover-surface',
    ],
  },
  // A ghost or outline danger row's label on the same fill (Remove on the member card). Its
  // hover is the danger tint, measured with the other danger roles.
  {
    text: '--trinity-danger',
    on: ['--trinity-neutral-fill-surface'],
  },
  {
    text: '--trinity-text-muted',
    on: PANE_GROUNDS,
  },
  {
    text: '--trinity-text-bright',
    on: [
      '--trinity-surface-overlay',
      '--trinity-surface-overlay-footer',
      '--trinity-chat',
      '--trinity-surface-floating-card',
      '--trinity-sidebar',
      '--trinity-surface-sidebar',
      '--trinity-hover',
      '--trinity-active',
    ],
  },
  {
    text: '--trinity-danger',
    on: [
      '--trinity-chat',
      '--trinity-surface-panel',
      '--trinity-surface-floating-card',
      '--trinity-sidebar',
      '--trinity-surface-sidebar',
      '--trinity-rail',
      '--trinity-hover',
      '--trinity-active',
      '--trinity-danger-tint-10',
      '--trinity-danger-tint-20',
      '--trinity-danger-tint-30',
    ],
  },
  {
    text: '--trinity-success',
    on: [
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-surface-sidebar',
      '--trinity-rail',
      '--trinity-hover',
      '--trinity-active',
    ],
  },
  {
    text: '--trinity-warning',
    on: [
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-surface-sidebar',
      '--trinity-rail',
      '--trinity-hover',
      '--trinity-active',
    ],
  },
  // Accent-coloured text. Deliberately NOT `--trinity-accent`: that is a fill, and a fill and
  // a readable text colour cannot be the same value and both clear AA — blurple is 3.19:1 on
  // the light row grounds. Splitting the role is what makes both assertable.
  {
    text: '--trinity-link',
    on: [
      '--trinity-chat',
      '--trinity-surface-panel',
      '--trinity-sidebar',
      '--trinity-surface-sidebar',
      '--trinity-rail',
      '--trinity-hover',
      '--trinity-active',
    ],
  },
  // A disabled solid primary or danger button (#1355): its label on its own neutral fill.
  // Opacity faded the label and its tinted fill together to 2.0:1, so the state is drawn with
  // these roles instead.
  {
    text: '--trinity-disabled-foreground',
    on: ['--trinity-disabled-surface'],
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
  // A solid action inside an attention surface (#1217): its label at rest and on hover.
  {
    text: '--trinity-state-attention-action-foreground',
    on: [
      '--trinity-state-attention-action-surface',
      '--trinity-state-attention-action-hover-surface',
    ],
  },
  // A form control on an attention surface (#1241): its typed value and its placeholder sit on
  // the accent directly, or on the segmented track, never on a nested neutral fill.
  {
    text: '--trinity-state-attention-control-foreground',
    on: [
      '--trinity-state-attention-surface',
      '--trinity-state-attention-control-track-surface',
    ],
  },
  {
    text: '--trinity-state-attention-control-placeholder',
    on: ['--trinity-state-attention-surface'],
  },
  {
    text: '--trinity-tooltip-foreground',
    on: ['--trinity-tooltip-surface'],
  },
  {
    text: '--trinity-status-neutral-foreground',
    on: ['--trinity-status-neutral-surface'],
  },
  {
    text: '--trinity-status-success-surface-foreground',
    on: ['--trinity-status-success-surface'],
  },
  {
    text: '--trinity-status-warning-surface-foreground',
    on: ['--trinity-status-warning-surface'],
  },
  {
    text: '--trinity-status-danger-surface-foreground',
    on: ['--trinity-status-danger-surface'],
  },
  {
    text: '--trinity-danger-solid-foreground',
    on: ['--trinity-danger-solid', '--trinity-danger-solid-hover'],
  },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    text: `--trinity-avatar-${n}-ink`,
    on: [`--trinity-avatar-${n}`],
  })),
  // A concealed spoiler's reason (rendered-markdown.scss): drawn in `--trinity-message-surface`
  // on a bar filled with `--trinity-text-bright`. The message surface is the workspace pane in
  // the timeline and threads, raised in the composer preview and overlay in edit history.
  ...[
    '--trinity-surface-workspace',
    '--trinity-surface-raised',
    '--trinity-surface-overlay',
  ].map((surface) => ({ text: surface, on: ['--trinity-text-bright'] })),
];

/** Essential graphics and focus indicators use WCAG's 3:1 non-text threshold. */
const NON_TEXT_ROLES = [
  // The underline tabs' selected bar (`trnTabs appearance="underline"`) on the cards it sits in.
  {
    foreground: '--trinity-accent',
    on: ['--trinity-surface-overlay', '--trinity-surface-raised'],
  },
  {
    foreground: '--trinity-focus-ring',
    on: [
      '--trinity-surface-frame',
      '--trinity-surface-workspace',
      '--trinity-surface-raised',
      '--trinity-surface-floating',
      '--trinity-surface-floating-card',
      '--trinity-surface-panel',
      '--trinity-state-hover-surface',
      '--trinity-state-pressed-surface',
    ],
  },
  {
    foreground: '--trinity-focus-ring-on-attention',
    on: ['--trinity-state-attention-surface'],
  },
  // The same action's fill, at rest and on hover, must stand out from the attention surface
  // around it. Before #1217 it was the accent on the accent: 1:1.
  {
    foreground: '--trinity-state-attention-action-surface',
    on: ['--trinity-state-attention-surface'],
  },
  {
    foreground: '--trinity-state-attention-action-hover-surface',
    on: ['--trinity-state-attention-surface'],
  },
  // A control's resting boundary on an attention surface (#1241), and the segmented track
  // inside it: the selected option's inverted fill and the focus ring both sit on the track.
  {
    foreground: '--trinity-state-attention-control-border',
    on: [
      '--trinity-state-attention-surface',
      '--trinity-state-attention-control-track-surface',
    ],
  },
  {
    foreground: '--trinity-state-attention-action-surface',
    on: ['--trinity-state-attention-control-track-surface'],
  },
  {
    foreground: '--trinity-focus-ring-on-attention',
    on: ['--trinity-state-attention-control-track-surface'],
  },
  // An unchecked switch thumb on its attention track (#1244). The track is the control
  // border role, so the pair is measured by role rather than by today's shared tint.
  {
    foreground: '--trinity-state-attention-action-foreground',
    on: ['--trinity-state-attention-control-border'],
  },
  // An invalid control's border and ring on an attention surface (#1244); the neutral danger
  // falls to 1.25-1.43:1 there.
  {
    foreground: '--trinity-state-attention-control-danger',
    on: ['--trinity-state-attention-surface'],
  },
  ...[
    '--trinity-state-attention-surface',
    '--trinity-status-danger-surface',
    '--trinity-status-success-surface',
    '--trinity-status-warning-surface',
  ].map((foreground) => ({
    foreground,
    on: [
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-rail',
      '--trinity-surface-canvas',
    ],
  })),
  {
    foreground: '--trinity-border-control',
    on: [
      '--trinity-surface-canvas',
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-surface-raised',
    ],
  },
  // A disabled solid button's border keeps its shape visible: the neutral fill alone is
  // 1.02-1.64:1 against the panes (#1355).
  {
    foreground: '--trinity-disabled-border',
    on: [
      '--trinity-surface-canvas',
      '--trinity-chat',
      '--trinity-sidebar',
      '--trinity-surface-workspace',
      '--trinity-surface-raised',
      '--trinity-surface-overlay',
      '--trinity-surface-overlay-footer',
      '--trinity-status-neutral-surface',
    ],
  },
  // On an attention surface the border nearly matches the accent, so the neutral fill itself
  // carries the shape of a disabled solid primary that would otherwise invert there.
  {
    foreground: '--trinity-disabled-surface',
    on: ['--trinity-state-attention-surface'],
  },
  // A loading inline image's outline (rendered-markdown.scss, `.mx-image--loading`): on every
  // message surface around it, since its raised fill alone barely differs from the dark panes.
  {
    foreground: '--trinity-border-control',
    on: ['--trinity-surface-workspace', '--trinity-surface-overlay'],
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
    text: '--trinity-control-foreground',
    on: ['--trinity-surface-overlay', '--trinity-surface-overlay-footer'],
  },
  {
    text: '--trinity-control-muted-foreground',
    on: ['--trinity-surface-overlay', '--trinity-surface-overlay-footer'],
  },
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
  { text: '--destructive-foreground', on: ['--destructive'] },
  { text: '--success-foreground', on: ['--success'] },
  { text: '--warning-foreground', on: ['--warning'] },
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

blocks.push(...parseBlocks(source));

const productionThemes = catalogThemes(catalogSource);
const themes = [...productionThemes.map(({ id }) => id), SYNTHETIC_THEME.id];

/** Every (theme, mode, text, surface) pair that is measurable. */
function* pairs() {
  for (const theme of themes) {
    for (const mode of ['light', 'dark']) {
      const check = (text, surface) => {
        const fg = toRgb(resolve(text, theme, mode));
        const bg = toRgb(resolve(surface, theme, mode));
        return fg && bg
          ? { theme, mode, text, surface, ratio: ratio(fg, bg) }
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
  for (const theme of themes) {
    for (const mode of ['light', 'dark']) {
      for (const role of NON_TEXT_ROLES) {
        for (const surface of role.on) {
          const foreground = toRgb(resolve(role.foreground, theme, mode));
          const background = toRgb(resolve(surface, theme, mode));
          if (foreground && background) {
            yield {
              theme,
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
  it('measures text and control pairs on the overlay and its footer for every Theme and mode', () => {
    for (const theme of themes) {
      for (const mode of ['light', 'dark']) {
        for (const text of [
          '--trinity-text',
          '--trinity-text-muted',
          '--trinity-control-foreground',
        ]) {
          for (const surface of [
            '--trinity-surface-overlay',
            '--trinity-surface-overlay-footer',
          ]) {
            expect(
              measured.some(
                (pair) =>
                  pair.theme === theme &&
                  pair.mode === mode &&
                  pair.text === text &&
                  pair.surface === surface,
              ),
              `${theme} ${mode} ${text} on ${surface}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('keeps Theme metadata and CSS carriers bidirectionally complete', () => {
    const catalogCarriers = productionThemes
      .flatMap(({ dataTheme }) => (dataTheme === null ? [] : [dataTheme]))
      .sort();
    const cssCarriers = [
      ...new Set(
        [...productionSource.matchAll(/\[data-theme='([a-z0-9-]+)'\]/gu)].map(
          ([, carrier]) => carrier,
        ),
      ),
    ].sort();

    const catalogIds = productionThemes.map(({ id }) => id);
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    expect(
      productionThemes.filter(({ dataTheme }) => dataTheme === null),
    ).toHaveLength(1);
    expect(new Set(catalogCarriers).size).toBe(catalogCarriers.length);
    expect(cssCarriers).toEqual(catalogCarriers);
  });

  it('proves a sparse synthetic Theme needs only metadata and governed overrides', () => {
    const syntheticBlocks = parseBlocks(SYNTHETIC_THEME_CSS);
    const allowed = new Set([
      ...catalogRoles('colorRoles'),
      ...catalogRoles('elevationRoles'),
    ]);

    expect(syntheticBlocks.map(({ selector }) => selector)).toEqual([
      `:root[data-theme='${SYNTHETIC_THEME.dataTheme}']:not(.dark)`,
      `:root[data-theme='${SYNTHETIC_THEME.dataTheme}'].dark`,
    ]);
    expect(
      syntheticBlocks.every(
        ({ tokens }) =>
          tokens.size === 1 &&
          [...tokens.keys()].every((role) => allowed.has(role)),
      ),
    ).toBe(true);
    expect(themes).toContain(SYNTHETIC_THEME.id);
    expect(
      measured.filter(({ theme }) => theme === SYNTHETIC_THEME.id).length,
    ).toBeGreaterThan(0);
  });

  it('keeps product state colours on governed Theme roles', () => {
    const productStyles = globSync(
      ['apps/trinity/src/**/*.scss', 'libs/feature/**/*.scss'],
      { cwd: workspaceRoot },
    );
    const runtimeMixes = productStyles.filter((path) => {
      const authoredSource = readFileSync(join(workspaceRoot, path), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/.*$/gmu, '');
      return /color-mix\s*\(/u.test(authoredSource);
    });

    expect(productStyles.length).toBeGreaterThan(0);
    expect(runtimeMixes).toEqual([]);
  });

  it('keeps every Theme colour in explicit sRGB-safe OKLCH', () => {
    const themeSelectors = new Set([
      ':root',
      ':root.dark',
      ...themes.flatMap((theme) =>
        theme === 'trinity'
          ? []
          : [
              `:root[data-theme='${theme}']:not(.dark)`,
              `:root[data-theme='${theme}'].dark`,
            ],
      ),
    ]);
    const governedRoles = new Set([
      ...catalogRoles('colorRoles'),
      ...catalogRoles('elevationRoles'),
    ]);
    const themeBlocks = blocks.filter(({ selector }) =>
      themeSelectors.has(selector),
    );
    const invalidNotation = [];
    const outOfGamut = [];
    let authoredColours = 0;
    for (const { selector, tokens } of themeBlocks) {
      for (const [token, value] of tokens) {
        if (!governedRoles.has(token) || /^var\([^)]*\)$/u.test(value)) {
          continue;
        }
        const colours = [...value.matchAll(/oklch\([^)]*\)/giu)];
        const residue = value
          .replaceAll(/oklch\([^)]*\)/giu, '')
          .replaceAll(/(?:[-+]?\d*\.?\d+(?:px|rem|em|%)?|inset|[,/])/giu, '')
          .replaceAll(/\s/gu, '');
        if (colours.length === 0 || residue !== '') {
          invalidNotation.push(`${selector}: ${token} = ${value}`);
        }
        for (const match of colours) {
          authoredColours += 1;
          const colour = parseOklch(match[0]);
          if (!colour?.inSrgb) {
            outOfGamut.push(`${selector}: ${token} = ${match[0]}`);
          }
        }
      }
    }

    expect(authoredColours).toBeGreaterThan(0);
    expect(invalidNotation).toEqual([]);
    expect(outOfGamut).toEqual([]);
  });

  it('keeps chromatic colours off the hues Axe cannot parse after a colour mix', () => {
    // Tailwind's `/30` opacity utilities (Helm's `dark:bg-input/30`) compile to
    // `color-mix(in oklab, …)`. At 90, 180 or 270deg one oklab axis is a float residue, Chromium
    // serialises it as `9.53990e-11`, and Axe 4.13 cannot parse exponents, so every control
    // on that ground drops out of its contrast check as "incomplete".
    const residueHues = [
      ...productionSource.matchAll(
        /oklch\(\s*[\d.]+%?\s+([\d.]+)\s+(-?[\d.]+)(?:deg)?/giu,
      ),
    ]
      .filter(([, chroma, hue]) => {
        const turn = ((Number(hue) % 360) + 360) % 360;
        return Number(chroma) > 0 && turn !== 0 && turn % 90 === 0;
      })
      .map(([colour]) => colour);

    expect([...new Set(residueHues)].sort()).toEqual([]);
  });

  it('measures something, so an empty matrix cannot pass as a clean one', () => {
    // A parser change that stopped matching the theme blocks would otherwise report every
    // combination compliant.
    expect(themes.length).toBeGreaterThan(0);
    expect(measured.length).toBeGreaterThan(0);
  });

  it('reproduces a known ratio, so the maths is not merely self-consistent', () => {
    // White on the dark chat ground. Hand-checked against an independent calculator.
    expect(ratio([255, 255, 255], [49, 51, 56])).toBeCloseTo(12.63, 1);
  });

  it('rejects translucent colours instead of measuring invisible RGB channels', () => {
    expect(toRgb('rgb(0 0 0 / 0.25)')).toBeNull();
    expect(toRgb('rgb(0 0 0 / -0.1)')).toBeNull();
    expect(toRgb('rgb(0 0 0 / 1e-1)')).toBeNull();
    expect(toRgb('rgba(255, 255, 255, 50%)')).toBeNull();
    expect(toRgb('hsl(240deg 5% 10% / 1)')).toEqual(hslToRgb(240, 0.05, 0.1));
    expect(toRgb('oklch(0.5 0.5 0)')).toBeNull();
    expect(toRgb('oklch(0.5 0.1 240 / 0.5)')).toBeNull();
  });

  it('can actually measure every role it was given', () => {
    // The failure this closes: `toRgb` returning null drops the pair out of the matrix, so a
    // token written in a notation the parser does not know is not measured AND not reported —
    // the run stays green and the floor quietly stops covering it. Naming the gap is the
    // difference between "these all pass" and "these all pass, as far as I could tell".
    const unmeasurable = [];
    for (const theme of themes) {
      for (const mode of ['light', 'dark']) {
        for (const role of [...ROLES, ...HELM_ROLES]) {
          for (const token of [role.text, ...role.on]) {
            const value = resolve(token, theme, mode);
            if (!value) {
              unmeasurable.push(`${theme}/${mode}: ${token} is not defined`);
            } else if (!toRgb(value)) {
              unmeasurable.push(`${theme}/${mode}: ${token} = ${value}`);
            }
          }
        }
      }
    }

    expect([...new Set(unmeasurable)].sort()).toEqual([]);
  });

  it('keeps the tooltip surface dark in every dark theme', () => {
    const failures = themes.flatMap((theme) => {
      const value = resolve('--trinity-tooltip-surface', theme, 'dark');
      const colour = toRgb(value);
      if (!value || !colour) {
        return [`${theme}/dark: tooltip surface is not measurable`];
      }
      const level = luminance(colour);
      return level < 0.2
        ? []
        : [
            `${theme}/dark: --trinity-tooltip-surface = ${value} (${level.toFixed(3)} luminance)`,
          ];
    });

    expect(failures).toEqual([]);
  });

  it('clears WCAG AA for every text role on every surface it lands on', () => {
    const failures = measured
      .filter((m) => m.ratio < AA)
      .map(
        (m) =>
          `${m.theme}/${m.mode}: ${m.text} on ${m.surface} = ${m.ratio.toFixed(2)}:1`,
      )
      .sort();

    expect(failures).toEqual([]);
  });

  it('keeps essential graphics and focus above the non-text contrast floor', () => {
    expect(measuredNonText.length).toBe(
      themes.length *
        2 *
        NON_TEXT_ROLES.reduce((total, role) => total + role.on.length, 0),
    );
    const failures = measuredNonText
      .filter((measurement) => measurement.ratio < 3)
      .map(
        (measurement) =>
          `${measurement.theme}/${measurement.mode}: ${measurement.foreground} on ${measurement.surface} = ${measurement.ratio.toFixed(2)}:1`,
      )
      .sort();

    expect(failures).toEqual([]);
  });

  it('keeps the neutral fill visible as a shape on the panes that hold it', () => {
    // Decorative: the label names the action, so the floor is a visible shape, not 3:1.
    const failures = [];
    for (const theme of themes) {
      for (const mode of ['light', 'dark']) {
        for (const fill of [
          '--trinity-neutral-fill-surface',
          '--trinity-neutral-fill-hover-surface',
        ]) {
          for (const surface of [
            '--trinity-surface-overlay',
            '--trinity-surface-raised',
          ]) {
            const foreground = toRgb(resolve(fill, theme, mode));
            const background = toRgb(resolve(surface, theme, mode));
            const measuredRatio =
              foreground && background ? ratio(foreground, background) : 0;
            if (measuredRatio < 1.15) {
              failures.push(
                `${theme}/${mode}: ${fill} on ${surface} = ${measuredRatio.toFixed(2)}:1`,
              );
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('colours the room preview on a selected row with the measured selected-state foreground', () => {
    // A5: the preview used --trinity-text-muted on the selected surface (3.86:1 in dark). The
    // matrix above measures the selected foreground on that surface, so the preview must use it.
    const sheet = readFileSync(
      join(
        workspaceRoot,
        'libs/feature/rooms/src/lib/channel-sidebar/sidebar-room-list/sidebar-room-row/sidebar-room-row.component.scss',
      ),
      'utf8',
    );

    expect(sheet).toMatch(
      /&\.channel--selected\s*\{[^]*?\.channel__preview\s*\{\s*color:\s*var\(--trinity-state-selected-foreground\)/,
    );
  });
});
