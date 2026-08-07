# UI and theming

Trinity's interface is built from four stacked layers and coloured by two orthogonal
axes. This page covers both: what belongs in each layer, how the vendored spartan-ng
components are generated and where they have deliberately diverged, and how the design
token system works — including the one token trap that has caused the same bug more than
once.

## The four UI layers

| Layer         | Where                                                                   | What it is                                                              |
| ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Brain         | `@spartan-ng/brain` 1.3.0 in `node_modules`, plus `@angular/cdk` 22.1.0 | Headless primitives: behaviour, accessibility, positioning. No styling. |
| Helm          | `libs/spartan/*`, aliased `@trinity/helm/*`                             | The **styled** layer, copied into the repo by `@spartan-ng/cli`.        |
| `@trinity/ui` | `libs/ui`                                                               | Trinity's own presentational components and small UI utilities.         |
| Features      | `libs/feature/*`, aliased `@trinity/feature/*`                          | Screens and the components that make them up.                           |

Seventeen Helm libraries are installed: avatar, badge, button, card, checkbox,
dropdown-menu, input, label, overlay, progress, radio-group, select, sonner, spinner,
textarea, tooltip, utils. All are tagged `type:ui` and `scope:shared`.

`@trinity/ui` holds `AvatarComponent` (`<trn-avatar>`), `BannerComponent`,
`PageHeaderComponent`, `MediaBubbleComponent`, `MessageToolbarComponent`, plus
`EncryptionDialogService`, `runWithBusy` and `mediaQuerySignal`. The boundary rule is that
`type:ui` may depend only on ui, util and platform libraries — never on data-access, never
on the SDK.

That rule is what forces the injection-token pattern. `<trn-avatar>` needs to turn an
`mxc://` URI into a displayable blob URL, which is a data-access concern, so it injects an
optional `AVATAR_RESOLVER` token that `main.ts` wires to `AvatarService.resolve`. When the
token is absent — `ui` in isolation, or a unit test — the component falls back to its `url`
input. The same shape appears in `ENCRYPTION_DIALOG_COMPONENTS`, which lets a `type:ui`
service present a `type:feature` page as a modal without importing it. See
[libraries](libraries.md) for the boundary rules in full.

## The Helm libraries are generated

`libs/spartan/*` is canonical spartan-ng Helm code produced by `@spartan-ng/cli`. Add or
regenerate a component with the CLI rather than hand-authoring it:

```bash
pnpm exec nx g @spartan-ng/cli:ui <name>
```

Configuration lives in the root `components.json`:

```json
{
  "componentsPath": "libs/spartan",
  "buildable": false,
  "generateAs": "library",
  "style": "nova",
  "importAlias": "@trinity/helm"
}
```

Generated code intentionally breaks the app's own conventions — `hlm` and `brn` selector
prefixes, un-suffixed class names such as `HlmButton`, and aliased inputs including
`class`. Rather than fight the generator on every resync, `eslint.config.mjs` exempts
`libs/spartan/**/*.ts` from `component-class-suffix`, `component-selector`,
`directive-selector` and `no-input-rename`.

Only `libs/spartan/overlay` has a Vitest target; every other Helm library is build and lint
only. That is why the specs pinning Helm behaviour live in `overlay` and import across the
library boundary.

!!! warning "Never assert on a Helm component's host class string"

    Helm styles its host through the asynchronous `classes()` manager in
    `libs/spartan/utils/src/lib/hlm.ts` — an `effect()` plus a document-wide
    `MutationObserver` that applies the merged class string on a microtask or
    animation-frame schedule. Asserting the applied host classes produces flaky specs.
    Assert the pure, synchronous `cva` functions instead (`buttonVariants`,
    `badgeVariants`) plus the fact that the component renders without throwing. This is
    stated as a rule in
    [`helm-components.spec.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/spartan/overlay/src/lib/helm-components.spec.ts).

## The overlay library is Trinity code

Despite living under `libs/spartan/` and being aliased `@trinity/helm/overlay`, this
library is **hand-authored**, not generated. It holds the imperative overlay adapters:
`TrnDialogService`, `TrnAlertService` with `TrnAlertDialogComponent`, `TrnActionSheetService`
with `TrnActionSheetComponent`, and `TrnToastService` — built on CDK Dialog and Overlay plus
brain sonner. It re-exports CDK's `DialogRef` so a modal'd component can call
`inject(DialogRef).close(data)` without importing `@angular/cdk` directly.

```ts
const ref = this.dialog.open(MyComponent, {
  inputs: { roomId },
  side: 'end',
  autoFocus: '[data-autofocus]',
});
```

`side: 'end'` pins a full-height right-edge side panel; that is what the thread, pinned and
message-search panels use, sized `w-screen md:w-[480px]` so they go full-screen on mobile.

!!! warning "Two dialog traps"

    **A CDK dialog panel is transparent.** Every dialog component paints its own surface, and
    one that forgets renders as text floating over the timeline — easy to miss in review,
    because the layout is correct in isolation and only the background is wrong. Use the
    `dialog-surface($width)` mixin from
    [`_mixins.scss`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/feature/rooms/src/lib/styles/_mixins.scss).

    **`autoFocus` defaults to CDK's `'first-tabbable'`**, which is wrong for any dialog whose
    header carries a Cancel or Close button ahead of the field the user came to type in — the
    button wins. A component-side `focus()` cannot fix it, because CDK focuses *after* attach
    and overrides the earlier call. Name the element instead: `autoFocus: '[data-autofocus]'`.

!!! warning "Import toast from brain, not ngx-sonner"

    `<hlm-toaster/>` wraps brain's `<brn-sonner-toaster/>`, which reads **brain's own**
    `toastState`. Since spartan 1.1 brain ships its own sonner port and no longer depends on
    `ngx-sonner`, so calling `ngx-sonner`'s `toast()` pushes into a store the mounted toaster
    never observes. The toast silently never appears — no error, no console output, nothing in
    the DOM. `TrnToastService` is the one place that imports it.

## Registered vendored divergences

Local changes to generated Helm code. A regenerate silently drops all of them, so each is
commented at its site, listed in a banner at the top of its file, and **pinned by a test** —
a lost override fails the suite rather than shipping. This table is the register; keep it in
step with the banner in
[`hlm-dropdown-menu.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/spartan/dropdown-menu/src/lib/hlm-dropdown-menu.ts).

| File and symbol                                              | Override                                                                                                                       | Pinned by                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `dropdown-menu` · `HlmDropdownMenuSubTrigger`                | `_handleClick` shadowed so a sub-trigger click opens the submenu instead of toggling it closed under zoneless change detection | `dropdown-menu-submenu.spec.ts` |
| `dropdown-menu` · `HlmDropdownMenuSubTrigger`                | The same shadow re-does CDK's focus move, so keyboard Enter and Space land inside the submenu                                  | `dropdown-menu-submenu.spec.ts` |
| `dropdown-menu` · `HlmDropdownMenuSubTrigger`                | `side` defaults to `'right'`, so a submenu opens beside its parent rather than over it                                         | `dropdown-menu-submenu.spec.ts` |
| `dropdown-menu` · `HlmDropdownMenu` and `HlmDropdownMenuSub` | `CdkTargetMenuAim` host directive                                                                                              | `dropdown-menu-submenu.spec.ts` |
| `dropdown-menu` · `HlmDropdownMenuItem`                      | A destructive item's text and icon use `text-danger`, not upstream's `text-destructive`                                        | `dropdown-menu-submenu.spec.ts` |
| `badge` · `badgeVariants`                                    | Adds `success` and `warning` variants that upstream Helm does not ship                                                         | `helm-components.spec.ts`       |

The specs live in
[`libs/spartan/overlay/src/lib`](https://github.com/quwisky/trinity-matrix-client/tree/develop/libs/spartan/overlay/src/lib).

The `CdkTargetMenuAim` row is a consequence of the row above it. CDK closes an open submenu
the moment the pointer enters any non-trigger sibling row, unless a `MENU_AIM` is provided —
and upstream Helm provides none. While submenus opened _over_ their parent that was
unreachable; opening them beside it means the pointer now travels across those rows, and a
diagonal move into the submenu closed it before arrival.

One more directive in that file is worth checking against upstream before a resync, even
though it is not a divergence from a shipped upstream behaviour:
`HlmDropdownMenuFocusOnHover`, applied as a host directive to every dropdown item type. It
moves DOM focus on `mouseenter`, because CDK menus only move focus with the keyboard — so a
closing submenu would drop focus to `<body>`, the menu stack would report no focus, and the
whole dropdown would collapse.

`hlm-dropdown-menu.ts` has also diverged in **shape**: the generator emits roughly sixteen
one-directive files where the repo keeps a single module. Reconciling a regenerate is manual
work regardless of the overrides.

## Tailwind v4 is configured entirely in CSS

There is no `tailwind.config.js`. Everything is in
[`apps/trinity/src/theme/spartan.css`](https://github.com/quwisky/trinity-matrix-client/blob/develop/apps/trinity/src/theme/spartan.css),
which is **framework wiring only** and owns no colour values:

```css
@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/preflight.css' layer(base);
@import 'tailwindcss/utilities.css' layer(utilities);
@import 'tw-animate-css';

@source '../../../../libs';
@source '../../../../apps';

@custom-variant dark (&:where(.dark, .dark *));
```

`preflight.css` is the app's base reset. The `@source` globs cover the whole workspace
because Helm's variant class strings live in `.ts` files, not templates.

The `@theme inline` block maps each Helm token to a Tailwind colour utility **by reference**
(`--color-card: var(--card)`), which is what makes flipping the mode or the palette re-theme
every utility at runtime rather than at build time. Only entries inside a `@theme` block
generate a utility, which is why the two non-colour tokens live there rather than in
`variables.scss`: `--text-13` (0.8125rem — the compact body size used across templates as
`text-13`, between Tailwind's `text-xs` and `text-sm`) and `--animate-indeterminate`.

Build wiring loads stylesheets in this order: `global.scss`, `theme/variables.scss`,
`theme/spartan.css`, `rendered-markdown.scss`, the CDK overlay prebuilt stylesheet, then the
emoji-mart picker CSS.

ESLint runs `eslint-plugin-tailwindcss` pointed at `spartan.css` with `classnames-order` off
(`prettier-plugin-tailwindcss` owns ordering) and `no-custom-classname` off (the app mixes
BEM class names with utilities). The remaining rules are warnings.

!!! warning "inlineCritical must stay false in production"

    The production configuration pins `optimization.styles.inlineCritical: false`. Angular's
    critical-CSS inlining rewrites the stylesheet link into a preload with an `onload` swap,
    and that handler never fires under the custom `trinity://` protocol the Electron shell
    serves from. The token stylesheet never activates, every `var(--trinity-*)` falls back to
    nothing, and the desktop build renders unthemed. This is how the desktop dark theme broke
    once already.

## Design tokens

Every colour and radius in the app is defined once, in
[`apps/trinity/src/theme/variables.scss`](https://github.com/quwisky/trinity-matrix-client/blob/develop/apps/trinity/src/theme/variables.scss).

### Two orthogonal axes

| Axis    | Carrier                                                 | Default                                   |
| ------- | ------------------------------------------------------- | ----------------------------------------- |
| Mode    | the `.dark` **class** on `<html>` — presence means dark | light, the bare `:root` block             |
| Palette | the `data-theme` **attribute** on `<html>`              | `trinity`, which sets no attribute at all |

Both are owned by
[`ThemeService`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/platform-native/src/lib/theme.service.ts)
and persisted under `trinity.theme` and `trinity.palette`. The axes compose: any palette
works in either mode.

### Two token families

**Trinity tokens** (`--trinity-*`) are the app's own vocabulary, consumed directly by
hand-authored component SCSS.

| Group                               | Tokens                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces, lightest to most recessed | `--trinity-rail`, `--trinity-sidebar`, `--trinity-sidebar-header`, `--trinity-chat`                                                                 |
| Surface states                      | `--trinity-hover` (row hover), `--trinity-active` (selected row), `--trinity-divider`, `--trinity-surface` (floating controls), `--trinity-members` |
| Text                                | `--trinity-text`, `--trinity-text-muted`, `--trinity-text-bright`                                                                                   |
| Brand                               | `--trinity-accent`, `--trinity-accent-foreground`, `--trinity-green`, `--trinity-green-foreground`                                                  |
| Danger                              | `--trinity-danger`, `--trinity-danger-solid`, `--trinity-danger-solid-foreground`                                                                   |
| Radii                               | `--trinity-radius` (8px), `-sm` (4px), `-md` (6px), `-xl` (12px), `-pill` (9999px)                                                                  |
| Syntax                              | eight `--trinity-syntax-*` roles plus `-plain`                                                                                                      |

**Helm and shadcn tokens** (`--background`, `--card`, `--primary`, `--muted-foreground`,
`--border`, and the rest) are consumed by the generated Helm components through Tailwind
colour utilities.

Where a Helm token always equals a Trinity token it is defined **as a reference**, so a
palette only has to set the value once:

```scss
--card: var(--trinity-sidebar);
--primary: var(--trinity-accent);
--ring: var(--trinity-accent);
--input: var(--border);
```

Mode-invariant bindings are declared once in the base `:root` block. Two palettes ship:
`trinity` (blurple `#5865f2`) and `amethyst` (violet).

### The danger versus destructive rule

This is the trap that has bitten repeatedly. Read it before writing any alert copy.

!!! danger "Never use Helm's --destructive as a foreground colour"

    In a template the alert-text utility is **`text-danger`**, never `text-destructive`. In
    SCSS the alert text and icon token is **`--trinity-danger`**, never `--destructive`.

    shadcn treats `--destructive` as a **fill-only** token, always paired with a near-white
    `--destructive-foreground` drawn on top of it. In dark mode its value is
    `hsl(0deg 62.8% 30.6%)` — `#7f1d1d`, a near-black maroon. Measured as text, that is
    **1.26:1** on the chat canvas and **1.38:1** on the dark popover surface. Alert copy, the
    E2EE warning shield, send-failed retry, and kick, ban and "Leave room" labels all render
    as an empty strip in dark mode, which is the app's default mode.

Trinity splits danger into three roles instead:

| Token                               | Role                                        | Light     | Dark      |
| ----------------------------------- | ------------------------------------------- | --------- | --------- |
| `--trinity-danger`                  | Alert **text and icons** drawn on a surface | `#bf1e24` | `#fc8181` |
| `--trinity-danger-solid`            | A **filled** badge                          | `#d92b31` | `#ef4444` |
| `--trinity-danger-solid-foreground` | The text on that fill                       | `#fff`    | `#1a1a1a` |

`spartan.css` maps `--color-danger: var(--trinity-danger)`, which is what makes the
`text-danger` utility exist.

Each value was measured against the **worst backdrop the role actually lands on**. One of
those is easy to overlook: `--trinity-hover`, because a row that recolours on hover is where a
danger label is usually read. `#bf1e24` clears 4.5:1 on chat, sidebar, rail and hover in both
palettes — worst case 4.83:1, on the rail.

`--trinity-active`, the selected-row tone, was **not** swept and reaches only 4.11–4.25:1. No
danger text lands on a selected row today; do not put one there without re-measuring.

!!! warning "A translucent tint has no fixed contrast"

    That sweep covers the token drawn straight onto a surface. It does **not** cover the
    `bg-destructive/10..30` tint Helm paints under its own destructive text, and no choice of
    colour could: the tint is translucent, so it takes whatever it is placed on. The same
    button measured **5.37:1 over `--card` and 4.28:1 at rest over `--trinity-rail`**, where
    the surface is already dark enough in light mode to push the label under AA — and the
    room-list and sidebar-panel destructive items sit on exactly those surfaces.

    So the tint is pinned **opaque**, as `--trinity-danger-tint` mixed over `--card`. Every
    destructive control now reads at the value the card was measured at wherever it is
    placed, and putting one on a new surface can no longer quietly fail. The check that
    matters is therefore that the ratio is *the same on every surface*, not merely above 4.5
    on the one you happened to try.

`--destructive` itself is left alone and stays the border and ring source, and the colour the
tint is mixed from. That is exactly what the token is for.

#### The unlayered override, and how to regenerate its selector list

Helm paints destructive controls as `bg-destructive/10..30` with `text-destructive` on top:
one token serving as both the tint and the ink drawn on it. That is unfixable by retoning
`--destructive`, because the tint _is_ the text colour diluted — every red that clears 4.5:1
against its own 20% tint is above 90% lightness, which is a pale pink that no longer reads as
danger.

So `spartan.css` decouples the roles with **unlayered** rules. Tailwind emits utilities into
`@layer utilities`, and unlayered declarations outrank every cascade layer, so this wins
without a specificity war.

!!! warning "The selector list must cover every emitted variant"

    An unmatched variant does not degrade gracefully — it produces a *half-styled* control: a
    legible "Leave room" label beside an icon still sitting at roughly 1.3:1. The dropdown
    menu colours its child icon through a **separate** rule targeting the `ng-icon`
    descendant, so fixing the item alone leaves the glyph behind.

    After running the spartan CLI, re-derive the list mechanically from the built CSS rather
    than by reading Helm's class strings:

    ```bash
    pnpm exec nx build trinity
    tr '}' '\n' < www/styles-*.css | grep 'text-destructive.*color:var(--destructive)'
    ```

### Syntax-highlighting tokens are measured, not picked

Eight roles colour fenced code blocks, consumed from exactly one place —
`rendered-markdown.scss`, on the `tok-*` classes the highlighter emits. The role names must
stay in step with `TOKEN_ROLES` in
[`code-highlight.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util/matrix/src/lib/code-highlight.ts).

The backdrop is `--trinity-rail`, not the chat canvas — that is the `pre` background — and
every value clears 4.5:1 against it in both shipped palettes (worst case 4.61:1 light,
5.16:1 dark). The light set is One Light's hues _darkened until they passed_; the published
values sit at 2.5–3.8:1 on this rail and are not usable as body text. One Dark's values pass
unchanged. `-plain` and `-punctuation` are `var()` references to `--trinity-text` and
`--trinity-text-muted`, so they follow the mode automatically.

A new palette inherits all eight, and nothing checks them. If your rail departs from
`#e3e5e8` or `#e7e2f0` (light) or `#1e1f22` or `#1c1826` (dark), re-measure.

Highlighting itself is Shiki with thirteen statically imported grammars — roughly 813 KB raw
and 134 kB gzipped. The module is reachable **only** through the
`@trinity/util/matrix/code-highlight` path alias and is imported for side effect at the top
of `rooms.page.ts`, so the grammars land in the lazy rooms chunk. Exporting it from the
`@trinity/util/matrix` barrel would drag every grammar into the eager bundle, because
`message-view.ts` consumes the highlighter and sits there.

## Adding a palette

Two steps.

**1. Add two CSS blocks in `variables.scss`**, copying the `amethyst` pair:

```scss
:root[data-theme='<id>']:not(.dark) {
  // overrides for light
}

:root[data-theme='<id>'].dark {
  // overrides for dark
}
```

Override only what differs; anything omitted falls through to `:root` or `:root.dark`.

You will mostly be overriding Trinity tokens. Helm tokens defined as references re-theme for
free — `--primary` and `--ring` in both modes, and in **dark** also `--card`, `--popover`,
`--secondary`, `--muted` and `--accent`. Helm tokens holding a _literal_ need explicit
overrides:

| Token                                            | When it needs an override     |
| ------------------------------------------------ | ----------------------------- |
| `--foreground`, `--muted-foreground`, `--border` | Both modes                    |
| `--secondary`, `--muted`, `--accent`             | Light only                    |
| `--background`                                   | Dark, where it is a literal   |
| `--primary-foreground`                           | Whenever your accent is light |

That last one matters. Amethyst dark sets `--primary-foreground: #1e1633` at 6.3:1, because
white on `#a78bfa` is 2.7:1 and fails WCAG AA. `--trinity-accent-foreground` tracks
`--primary-foreground`, so on-accent text follows automatically.

**2. Register the palette** in `TRINITY_PALETTES` in `theme.service.ts` so it appears in
Appearance settings:

```ts
export const TRINITY_PALETTES = [
  { id: 'trinity', label: 'Trinity' },
  { id: 'amethyst', label: 'Amethyst' },
] as const;
```

`setPalette()` writes or removes the `data-theme` attribute; the default palette applies no
attribute at all.

!!! danger "Scope the light block with :not(.dark)"

    Attribute selectors weigh in the same specificity column as classes, so
    `:root[data-theme='x']` is (0,2,0) — a **tie** with `:root.dark`. Being authored later it
    wins, and the palette's light values leak into dark mode.

    Scoping the light block `:not(.dark)` raises it to (0,3,0) *and* makes it simply not
    match in dark. The intended ladder is:

    - `:root` at (0,1,0)
    - `:root.dark` at (0,2,0)
    - `:root[data-theme='x']:not(.dark)` and `:root[data-theme='x'].dark`, both at (0,3,0)

    Writing `:root.dark` rather than a bare `.dark` is also deliberate: it is what makes dark
    outrank the light default regardless of stylesheet bundle order. A bare `.dark` losing to
    `:root` is how the Electron build once shipped a broken dark theme.

### Verifying a token change

!!! warning "Nothing checks that a consumed token exists"

    There is no lint rule, no test and no build check. `.stylelintrc.json` sets
    `custom-property-pattern: null` and does no cross-file resolution. A `var(--x)` with **no
    fallback** whose custom property is undefined causes the browser to drop the whole
    declaration — the page still renders, just wrong, with nothing logged.

    The manual check is to grep every `var(--trinity-…)` used without a fallback across
    `libs` and `apps` and confirm each exists in `variables.scss`. References that *do* supply
    a fallback are safe, since they render the fallback.

    Running that check today finds one live instance:
    `libs/feature/rooms/src/lib/account-picker/account-picker.component.scss` uses
    `var(--trinity-radius-lg)`, which `variables.scss` does not define — the mobile
    account-picker dialog renders with square corners. The base 8px token is
    `--trinity-radius`. Note that `spartan.css` *does* define a Tailwind `--radius-lg`, which
    is a different namespace.

    In the other direction, `--trinity-accent-hover` is defined in all three palette blocks
    and consumed by nothing.

The same class of unchecked invariant applies to the eight `--trinity-syntax-*` contrast
ratios whenever a palette changes `--trinity-rail`.

## Rendered markdown is styled globally

Message bodies are injected with `[innerHTML]`, so their children carry no Angular
emulated-encapsulation attributes and a component stylesheet cannot reach them.
[`apps/trinity/src/rendered-markdown.scss`](https://github.com/quwisky/trinity-matrix-client/blob/develop/apps/trinity/src/rendered-markdown.scss)
styles them globally, scoped to the `.msg__text--html` container class.

This replaced the codebase's only `::ng-deep`, and it keeps the rules out of the component's
style budget — production budgets are `anyComponentStyle` warn at 6 kB, error at 8 kB.

The stylesheet is shared by `message-row` and the edit-history dialog, so past revisions
render identically. Only the child rules are shared: the container's own whitespace and
wrapping rules stay in each component's stylesheet, because the dialog renders in an overlay
that `message-row`'s scoped styles cannot reach.

One placement detail with a reason: a fenced block's language caption is generated from the
`language` attribute and positioned **bottom**-right, not top-right. The message hover
toolbar is anchored across the row's top edge, so a top-right caption lands underneath it on
a continuation row. Using generated content also keeps the caption out of the element's text,
so it cannot be selected, copied, or picked up by the edit-history diff.

## The HTML allowlist

One DOMPurify configuration in
[`message-view.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util/matrix/src/lib/message-view.ts)
serves both directions — incoming render and outgoing send.

- `MATRIX_ALLOWED_TAGS` is the Matrix specification list.
- `MATRIX_ALLOWED_ATTR` adds `data-mx-color`, `data-mx-bg-color` and `data-mx-spoiler`.
  `target` is intentionally omitted, which avoids reverse-tabnabbing without needing a
  post-sanitize `rel` hook.
- `class` is allowed globally by the attribute list, so it is narrowed by
  `ALLOWED_CLASS = /^(?:language-[\w-]+|mx-spoiler)$/`. Without that narrowing a sender could
  borrow app classes to spoof UI chrome.
- On render, a non-local `<img src>` is stripped — `LOCAL_IMG_SCHEME` permits `mxc:`, `blob:`
  and `data:` only. A remote source would be fetched on render, leaking the viewer's IP and
  acting as a read receipt. The CSP's `img-src` deliberately omits `https:` for the same
  reason: the app never binds a remote `<img>`, since avatars and media are fetched over
  `connect-src` and bound as blobs.

Only security belongs in the sanitizer hook. Attributes set inside `afterSanitizeAttributes`
are not re-filtered against the allowlist, so anything added there rides out onto the wire
too.

### Three deliberate outgoing rewrites

[`message-content.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/util/matrix/src/lib/message-content.ts)
overrides three `marked` renderers, each for a stated reason:

| Rewrite                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GFM task-list checkboxes become ballot-box glyphs          | `<input>` is in neither the Matrix nor Angular allowlist, so the checkbox was silently deleted on the wire and the done or not-done state was lost entirely. A glyph carries it through every client, screen reader and plain-text fallback.                                                                                                                                         |
| A markdown image with a non-`mxc:` source becomes a link   | Matrix requires an `mxc:` source, so anything else sanitizes down to a src-less empty box with the URL nowhere visible. `data:` is the deceptive case — DOMPurify's built-in `DATA_URI_TAGS` exception lets it through `<img>` regardless of the URI regexp, so it _looked_ carried while being just as unrenderable on arrival, after putting the whole base64 payload on the wire. |
| An anchor containing a generated image anchor is unwrapped | Nested `<a>` is unrepresentable in HTML. The parser's adoption-agency step split it, and the user's actual link target was lost.                                                                                                                                                                                                                                                     |

## Component conventions

- Element selectors are kebab-case with the `trn` prefix (`trn-avatar`, `trn-message-row`);
  directive selectors are camelCase with the same prefix.
- Component class names must end in `Page` or `Component`.
- Each component lives in its own directory as `name/name.component.ts` plus `.html`, `.scss`
  and `.spec.ts`.
- Shared SCSS mixins live in
  [`libs/feature/rooms/src/lib/styles/_mixins.scss`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/feature/rooms/src/lib/styles/_mixins.scss):
  `ellipsis`, `category-label`, `profile-card`, `dialog-surface($width)`, `column($bg)`,
  `interactive-row`, `scrollable`.
- Component SCSS references design tokens. Never hardcode a colour, or it will not re-theme
  with the mode or the palette.

More on the workspace-wide rules is in [conventions](../contributing/conventions.md).

## Overlay presentation

Nearly every dialog in `@trinity/feature/rooms` follows the same shape: a thin `*Service` owns
presentation and resolves a value, and the caller performs the action. In the rooms shell that
caller is one of the page-scoped coordinators beside `rooms.page.ts` rather than the page
itself — `RoomActionsService` drives `UserPickerService`, `ShellShortcutsService` drives
`QuickSwitcherService`, `MessageActionsService` drives `MessageSearchService` and
`PinnedPanelService`, and `MemberActionsService` drives `MemberInfoService` and
`UserCardService`. `EditHistoryDialogService` is the exception and always was: it is driven
from the message list and the thread view. `UserPickerService`
resolves an MXID and never invites anyone itself; `QuickSwitcherService` resolves a
selection; `MessageSearchService`, `PinnedPanelService` and `EditHistoryDialogService` each
resolve an event id to jump to; `MemberInfoService` and `UserCardService` resolve a user id
if "Message" was chosen.

Several carry an explicit re-entrancy guard, so a repeated trigger — pressing Ctrl+K while
the quick switcher is already open — is a no-op rather than stacking a second dialog.

`EncryptionDialogService` presents `/encryption/unlock` and `/encryption/verify` as CDK
modals at 768px and above, and as routed pages below. The routes stay the canonical
deep-link and mobile target, and the service falls back to routing whenever the lazy
component loaders are absent. See
[matrix and encryption](matrix-and-encryption.md) for what those flows do.

Toasts render through a single `<hlm-toaster/>` mounted in `AppComponent`.
