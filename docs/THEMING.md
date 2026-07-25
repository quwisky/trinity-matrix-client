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

Every **colour and radius** token lives in **`apps/trinity/src/theme/variables.scss`** —
the single source of truth for anything that re-themes. There are two families:

1. **Trinity tokens** (`--trinity-*`) — the app's own vocabulary, consumed directly by
   hand-authored component SCSS: surfaces (`--trinity-sidebar`, `--trinity-chat`,
   `--trinity-hover`, …), text (`--trinity-text`, `--trinity-text-muted`,
   `--trinity-text-bright`), brand + status (`--trinity-accent`, `--trinity-green`,
   `--trinity-danger` + `--trinity-danger-solid`/`--trinity-danger-solid-foreground`),
   the on-fill pairs (`--trinity-accent-foreground`, `--trinity-green-foreground`), syntax
   highlighting (`--trinity-syntax-*`, see below), and radii (`--trinity-radius*`).
2. **Helm/shadcn tokens** (`--background`, `--card`, `--primary`, `--muted-foreground`,
   `--border`, …) — consumed by the generated Helm components through Tailwind colour
   utilities (`bg-card`, `text-muted-foreground`, `border-border`, …).

**`apps/trinity/src/theme/spartan.css`** is framework wiring — it owns no _colour_
values. Its `@theme inline` block maps each Helm token to a Tailwind colour utility _by
reference_ (`--color-card: var(--card)`), so flipping the mode or palette re-themes every
utility at runtime.

It does own the handful of non-colour tokens that must **generate a Tailwind utility**,
because only entries inside a `@theme` block do: `--text-13` (0.8125rem, the compact
body-text size used across the templates) and `--animate-indeterminate`. A token that
templates consume as a class (`text-13`) therefore cannot move to variables.scss; a token
consumed as `var(--…)` in SCSS belongs there.

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

- **Danger / alert red** → one of the two roles below, never a hex red. Picking the wrong
  one is the easiest way to ship invisible text, so see [Danger has two roles](#danger-has-two-roles).
- **Text on the accent** (a filled primary button/pill) → `var(--trinity-accent-foreground)`,
  not `#fff` — white fails WCAG AA on light-accent palettes (e.g. Amethyst dark). The token
  tracks the Helm `--primary-foreground`, so a palette overrides that one value and both
  Helm buttons and hand-authored pills follow. Same shape for green fills:
  `var(--trinity-green-foreground)`.
- **Radii** → the `--trinity-radius*` scale, not pixel literals.
- Legitimately fixed values (scrim/shadow blacks like `rgb(0 0 0 / 30%)`, `#fff` text baked
  onto a fixed-colour chip) are fine.

Content injected via `[innerHTML]` (rendered Matrix markdown) carries no Angular
encapsulation attributes, so it's styled globally in
`apps/trinity/src/rendered-markdown.scss` (scoped to `.msg__text--html`) rather than with
the deprecated `::ng-deep`.

### Danger has two roles

No single red can be both a readable **foreground** and a distinct **fill** in dark mode:
text needs contrast _against_ the canvas, a badge needs contrast _from_ it while still
carrying legible text. So there are three tokens, and which one you want depends on
whether the red is the ink or the background:

| Token                               | Use it for                                         | Light     | Dark                 |
| ----------------------------------- | -------------------------------------------------- | --------- | -------------------- |
| `--trinity-danger`                  | alert **text/icons** drawn on a surface (`color:`) | `#bf1e24` | `#fc8181`            |
| `--trinity-danger-solid`            | a **filled** badge/pill background                 | `#d92b31` | `#ef4444`            |
| `--trinity-danger-solid-foreground` | the text sitting on that fill                      | `#fff`    | near-black `#1a1a1a` |

In a template, the matching Tailwind utility is **`text-danger`**, not `text-destructive` —
the latter reads `--destructive` and hits the trap described below.

**Do not reach for Helm's `--destructive` instead** — it looks like the same thing and is
not. shadcn treats it as a fill-only token, always paired with the near-white
`--destructive-foreground` under it, and in dark it is `hsl(0deg 62.8% 30.6%)` = `#7f1d1d`,
a near-black maroon. Used as a `color:` on the chat canvas that is **1.26:1** — the E2EE
warning shield, the send-failed retry and the kick/ban labels all simply vanish, in the
mode that is the app's default. `--destructive` stays as-is for Helm's destructive buttons
(shadcn parity), and `spartan.css` maps `--color-danger` to `--trinity-danger` so the
`text-danger` utility resolves to the text role.

### Why Helm's destructive text is overridden, not retoned

The generated Helm components (`libs/spartan/*`, owned by `@spartan-ng/cli` — never
hand-edited) style destructive buttons, badges and menu items as `bg-destructive/10..30`
with `text-destructive` on top: **one token acting as both the background tint and the text
drawn on it.** No value of `--destructive` fixes that, because the tint is that same colour
diluted, so the contrast between them is capped — every red clearing 4.5:1 against its own
20% tint turns out to be above 90% lightness, a pale pink that no longer reads as danger.

So `spartan.css` decouples the roles instead: `--destructive` keeps its shadcn value and
remains the tint/border/ring source, while an **unlayered** rule redirects only the
`text-destructive` utilities to `--trinity-danger`. Unlayered declarations outrank every
`@layer`, and Tailwind emits utilities into `@layer utilities`, so the override wins without
a specificity war.

**The selector list must cover every emitted variant, and a miss is not benign.** An
unmatched variant leaves that element on the old colour — so you get a _half-styled_
control, e.g. a legible menu label beside an icon still sitting at ~1.3:1. The dropdown menu
is the case to remember: it colours its child icon through a separate rule targeting the
`ng-icon` descendant, so matching the menu item alone leaves the glyph behind. After running
the spartan CLI, re-derive the list mechanically from the built CSS rather than by reading
Helm's class strings — that is how the icon variant was missed the first time:

```bash
pnpm exec nx build trinity
tr '}' '\n' < www/styles-*.css | grep 'text-destructive.*color:var(--destructive)'
```

The `--trinity-danger*` values above were instead measured against the surfaces each role
actually lands on — and the binding one is **`--trinity-hover`**, not the chat canvas: a row
that recolours on `:hover` is where a danger label is usually read, and it is the tightest
of the six surface/palette combinations. The per-pair ratios are recorded in the rationale
comments in `variables.scss`. Re-measure against the hover tones if you change a surface: no
palette overrides the danger reds today, so every palette inherits these three values.

### Syntax colours are measured against the code background

`--trinity-syntax-*` (eight roles: keyword, string, number, comment, function, type,
variable, punctuation) colour the tokens inside a fenced code block. They are consumed from
exactly one place — `apps/trinity/src/rendered-markdown.scss`, on the `tok-*` classes the
sanitizer's highlighter emits — and the role names are kept in step with `TOKEN_ROLES` in
`libs/util-matrix/src/lib/code-highlight.ts`.

Two things a palette author needs to know:

- **The backdrop is `--trinity-rail`**, not the chat canvas: that is the `pre` background.
  Every value is measured against it, at **4.5:1 or better** — these are body text, not
  decoration. The shipped light set is One Light's palette _darkened until it passed_; the
  published values sit at 2.5–3.8:1 on our rail and are not usable as-is. One Dark's pass
  unchanged.
- **A new palette inherits them.** The default and Amethyst rails are close enough in tone
  (`#e3e5e8`/`#e7e2f0` light, `#1e1f22`/`#1c1826` dark) that one light set and one dark set
  clear the bar on all four combinations. **If your palette's `--trinity-rail` departs from
  those tones, re-measure all eight and override the ones that fail** — nothing checks this
  automatically. `--trinity-syntax-plain` and `-punctuation` are `var()` references to
  `--trinity-text`/`--trinity-text-muted`, so they follow whatever you set there.

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
- **Syntax colours are re-measured if the rail moved:** the eight `--trinity-syntax-*` are
  measured against `--trinity-rail` and inherited by every palette. If yours changes that
  surface materially, check all eight still clear 4.5:1 on it and override the ones that
  do not — no test catches this.
- Run `pnpm build`, `pnpm lint`, `pnpm stylelint`, and the `platform-native` /
  `feature-settings` unit tests after changes.
