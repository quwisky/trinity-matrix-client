# Theming

Trinity's look is driven entirely by CSS custom properties (design tokens). This doc
explains how they're organised and how to add a new colour palette.

## Two orthogonal axes

Appearance is the product of two independent axes, both owned by `ThemeService`
(`libs/platform-native/src/lib/theme.service.ts`) and reflected on `<html>`:

| Axis        | Values                             | Applied as                                           | Persisted key     |
| ----------- | ---------------------------------- | ---------------------------------------------------- | ----------------- |
| **Mode**    | `light` / `dark` (+`system`)       | the `.dark` class (present = dark)                   | `trinity.theme`   |
| **Palette** | `trinity` (default), `amethyst`, … | the `data-theme="<id>"` attribute (absent = default) | `trinity.palette` |

They compose: **every palette works in both light and dark.** A palette sets colours;
the mode decides which set is active.

## Token layers

All tokens live in **`apps/trinity/src/theme/variables.scss`** — the single source of
truth. There are two families:

1. **Trinity tokens** (`--trinity-*`) — the app's own vocabulary, consumed directly by
   hand-authored component SCSS: surfaces (`--trinity-sidebar`, `--trinity-chat`,
   `--trinity-hover`, …), text (`--trinity-text`, `--trinity-text-muted`,
   `--trinity-text-bright`), brand + status (`--trinity-accent`, `--trinity-green`,
   `--trinity-danger` — tracks the Helm `--destructive`), and radii (`--trinity-radius*`).
2. **Helm/shadcn tokens** (`--background`, `--card`, `--primary`, `--muted-foreground`,
   `--border`, …) — consumed by the generated Helm components through Tailwind colour
   utilities (`bg-card`, `text-muted-foreground`, `border-border`, …).

**`apps/trinity/src/theme/spartan.css`** is framework wiring only — it owns no values.
Its `@theme inline` block maps each Helm token to a Tailwind colour utility _by
reference_ (`--color-card: var(--card)`), so flipping the mode or palette re-themes every
utility at runtime.

Where a Helm token always equals a Trinity token, it's defined **as a reference** rather
than a duplicated literal, so a palette only sets the value once:

```css
--card: var(--trinity-sidebar); /* dark: card surface == sidebar tone */
--primary: var(--trinity-accent); /* brand accent drives the primary button/ring */
```

Mode- and palette-invariant bindings (e.g. `--primary`, `--ring`, `--input`,
`--card-foreground`/`--popover-foreground`) are declared **once** in the base `:root` and
follow their source token automatically. (A couple — `--secondary-foreground`,
`--accent-foreground` — are a touch lighter than `--foreground` in light, so the default
palette sets them per mode; a new palette can just bind them to `var(--foreground)`.)

## Consuming tokens in components

Hand-authored component SCSS should reference tokens, never hardcode a colour — a literal
won't follow the mode or palette. In particular:

- **Danger / alert red** → `var(--trinity-danger)` (mention badges, error text, destructive
  actions), not a hex red.
- **Text on the accent** (a filled primary button/pill) → `var(--primary-foreground)`, not
  `#fff` — white fails WCAG AA on light-accent palettes (e.g. Amethyst dark).
- **Radii** → the `--trinity-radius*` scale, not pixel literals.
- Legitimately fixed values (scrim/shadow blacks like `rgb(0 0 0 / 30%)`, `#fff` text baked
  onto a fixed-colour chip) are fine.

Content injected via `[innerHTML]` (rendered Matrix markdown) carries no Angular
encapsulation attributes, so it's styled globally in
`apps/trinity/src/rendered-markdown.scss` (scoped to `.msg__text--html`) rather than with
the deprecated `::ng-deep`.

## Cascade & specificity

The selectors are deliberate — they out-rank a bare `:root` so the intended block always
wins regardless of stylesheet bundle order (a bare `.dark` once lost to `:root` in the
Electron build):

| Block                  | Selector                           | Specificity |
| ---------------------- | ---------------------------------- | ----------- |
| Default palette, light | `:root`                            | 0,1,0       |
| Default palette, dark  | `:root.dark`                       | 0,2,0       |
| Named palette, light   | `:root[data-theme='x']:not(.dark)` | 0,3,0       |
| Named palette, dark    | `:root[data-theme='x'].dark`       | 0,3,0       |

**Attribute selectors weigh in the same column as classes**, so an unscoped
`:root[data-theme='x']` is (0,2,0) — the _same_ as `:root.dark`. It would tie the dark
default and, being authored later, leak its light values into dark. Scoping the light
block **`:not(.dark)`** (→ 0,3,0, and it simply doesn't match when `.dark` is present)
removes the tie. The dark block (0,3,0) out-ranks the default `:root.dark`.

A palette only needs to **override the tokens that differ** — anything it leaves unset
falls through to the default (`:root` in light, `:root.dark` in dark).

## Adding a palette

Two steps.

**1. Add the CSS blocks** in `variables.scss` (copy the `amethyst` example):

```scss
/* Light block is scoped :not(.dark) so its literals never leak into dark mode. */
:root[data-theme='ocean']:not(.dark) {
  --trinity-accent: #0ea5e9;
  --trinity-accent-hover: #0284c7;
  --trinity-sidebar: #eef4f8;
  --trinity-text: #0f2733;
  /* …only what differs from the default light palette… */
  --foreground: hsl(200deg 40% 12%); /* Helm tokens that hold a literal in light */
  --secondary-foreground: var(--foreground);
  --accent-foreground: var(--foreground);
  --secondary: #e2eef5;
  --muted: #e2eef5;
  --muted-foreground: hsl(200deg 25% 40%);
  --accent: #e2eef5;
  --border: #d4e4ee;
}

:root[data-theme='ocean'].dark {
  --trinity-accent: #38bdf8;
  --trinity-sidebar: #0f2733;
  --trinity-hover: #1d3a4a; /* dark --secondary/--muted/--accent alias this */
  --trinity-text: #d6e6f0;
  /* …dark overrides… (aliased Helm surfaces like --card follow --trinity-sidebar) */
  --background: hsl(200deg 40% 6%);
  --foreground: hsl(200deg 30% 95%);
  --muted-foreground: hsl(200deg 15% 62%);
  --border: #1d3a4a;
}
```

You mostly override the Trinity tokens. Helm tokens defined as references to Trinity
tokens re-theme for free: `--primary`/`--ring` (→ `--trinity-accent`), and in **dark**
`--card`/`--popover` (→ `--trinity-sidebar`) and `--secondary`/`--muted`/`--accent`
(→ `--trinity-hover`). The Helm tokens that hold a _literal_ value in a given mode need an
explicit override: `--foreground`, `--muted-foreground`, and `--border` (both modes); the
**light** `--secondary`/`--muted`/`--accent`; and `--background` (a literal in dark — set
it in the `.dark` block for a tinted canvas).

> **Contrast check the accent.** `--primary-foreground` defaults to white. If your palette
> picks a _light_ accent (as Amethyst does in dark: `#a78bfa`), white button labels fail
> WCAG AA — override `--primary-foreground` to a dark colour in that block (Amethyst dark
> uses `#1e1633`, 6.3:1). Verify every text-on-surface pair reaches 4.5:1.

**2. Register it** in `TRINITY_PALETTES` (`theme.service.ts`) so it appears in the
Appearance settings picker:

```ts
export const TRINITY_PALETTES = [
  { id: 'trinity', label: 'Trinity' },
  { id: 'amethyst', label: 'Amethyst' },
  { id: 'ocean', label: 'Ocean' }, // ← id must match the data-theme value above
] as const;
```

That's it. The `data-theme` attribute is applied by `ThemeService.setPalette()`, and the
Tailwind utilities + component SCSS pick up the new values with no further changes.

## Verifying

- **No visual regression to the default:** the `trinity` palette must render identically
  before/after any token change — the default `:root` / `:root.dark` values are the
  contract. Cross-check against the value table when editing them.
- **Every consumed token is defined:** a `var(--trinity-x)` with **no fallback** silently
  drops its declaration when `--trinity-x` is undefined, so check that each `--trinity-*`
  referenced without a fallback across `libs`/`apps` exists in `variables.scss`.
  References that supply a fallback (`var(--x, …)`) are safe — they render the fallback.
- Run `pnpm build`, `pnpm lint`, `pnpm stylelint`, and the `platform-native` /
  `feature-settings` unit tests after changes.
