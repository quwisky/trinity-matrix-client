# UI and theming

Trinity's interface is built from four stacked layers, and its appearance from a set of
orthogonal axes carried on `<html>` — two that colour it, three that size and annotate what
it renders. This page covers both: what belongs in each layer, how the vendored spartan-ng
components are generated and where they have deliberately diverged, and how the design
token system works — including the one token trap that has caused the same bug more than
once.

## The four UI layers

| Layer      | Where                                                                   | What it is                                                              |
| ---------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Brain      | `@spartan-ng/brain` 1.3.0 in `node_modules`, plus `@angular/cdk` 22.1.0 | Headless primitives: behaviour, accessibility, positioning. No styling. |
| Helm       | `libs/spartan/*`, aliased `@trinity/helm/*`                             | The **styled** layer, copied into the repo by `@spartan-ng/cli`.        |
| Components | `libs/components/*`, aliased `@trinity/components/*`                    | Trinity's public tier: the wrappers and components features reach for.  |
| Features   | `libs/feature/*`, aliased `@trinity/feature/*`                          | Screens and the components that make them up.                           |

The libraries under `libs/spartan/` are generated Helm primitives and a Trinity-authored
`tests` project that pins their behaviour inside the vendor tier. All are tagged `type:ui`,
`scope:shared` and `ui:vendor-wrapper`.

The public tier is five category-owned projects: foundations, controls, generic content,
navigation/layout and overlays. It contains only domain-neutral APIs such as `<trn-icon>`,
`<trn-emoji-picker>`, `<trn-avatar>`, `trnBtn`, page headers, dropdown directives and the root
toaster. Product-specific presentation is not shared: the media bubble and message toolbar live
with Conversations under `feature/rooms`, while application-surface loaders live in Application
Runtime. Public APIs compose or host kit primitives without leaking Helm selectors or types to
features.

### The public design-system contract

`architecture/design-system.json` is the machine-readable ownership ledger for the public
tier. `scripts/design-system-contract.mjs` compares it with the live Nx graph and TypeScript
entrypoints, so every `ui:public` project must appear exactly once and every consumable API must
resolve through `@trinity/components/*`. `pnpm architecture:check` runs that contract alongside
the wider architecture contract.

| Category            | Public responsibility                                              |
| ------------------- | ------------------------------------------------------------------ |
| `foundations`       | Iconography and UI utilities that other public components compose. |
| `controls`          | User-input primitives and field composition.                       |
| `overlays`          | Generic dialogs, sheets, menus and notifications.                  |
| `navigation-layout` | Structural surfaces, navigation, tabs and page hierarchy.          |
| `generic-content`   | Domain-neutral presentation such as avatars, banners and progress. |

The ledger records the Storybook host as `nonConsumable`: it supports the tier but is not
application API. Every category owns exactly one public entrypoint, migration exceptions are
forbidden, and the contract rejects broad `export *` barrels. Adding a shallow public project or
silently expanding an entrypoint therefore fails `pnpm architecture:check`.

The login page is the first production proof screen. It composes labels, inputs, buttons,
cards, icons, overlays and progress only through Trinity entrypoints, including
`@trinity/components/controls` for the native label/control association. The executable ledger
pins those imports and selectors; unit and browser tests pin the interaction and accessible
name. Subsequent feature migrations should add or replace proof screens only when they exercise
a genuinely new public contract, rather than turning the ledger into a list of every consumer.

Icon-only actions use one of two public contracts. A standard square action uses `trnBtn` with
an `icon*` size, which supplies the shared shape and automatically opts into the common pointer,
hover and pressed states. A purpose-built control whose geometry carries meaning—a reaction chip,
server-rail pill, avatar action or compact toolbar button—uses `trnIconButton` instead. It keeps
that geometry but receives the same interaction states; the owning component must explicitly
centre its glyph within that custom box. In both forms the inner `<trn-icon>` must
choose an explicit semantic `motion` (`nudge-left`, `nudge-up`, `nudge-down`, `nudge-up-right`,
`pop` or `rotate`); motion never moves the hit target, and reduced-motion mode removes the glyph
transform while retaining colour and focus feedback.

Themeable interactive labels use `trnTooltip` alongside their `aria-label`, not a native `title`: the
native surface is browser/OS chrome and cannot follow Trinity's theme. A source guard keeps native
titles off every button and link; vertically stacked navigation and member labels open sideways so a
hoverable overlay cannot cover the preceding control. The public tooltip wrapper keeps Helm's geometry
and motion but replaces its inverted colours with the semantic `--trinity-tooltip-surface` /
`--trinity-tooltip-foreground` pair. Light mode preserves the dark tooltip treatment; dark mode
resolves the surface through the active palette's elevated popover tokens, including the arrow.

`libs/ui` is gone entirely. View helpers live in `@trinity/util/ui` (`type:util`, reachable
from every layer), while Workspace application-surface presentation owns settings and Trust
placement. Its Trust loader token is declared by Application Runtime and supplied by `main.ts`;
settings composition stays app-local. `@trinity/components/overlay` remains a generic,
swappable dialog/menu/toast wrapper and knows no product routes or feature loaders.

That tier is closed from both sides. The vendor bans stop everything below the UI layer
naming `@spartan-ng/brain`, `@angular/cdk`, `@ng-icons` or `@ctrl/ngx-emoji-mart`; and a
`no-restricted-imports` pattern over `libs/feature` and `apps` stops them reaching
past the tier into `@trinity/helm/*`. Feature code asks for `@trinity/components/*`, full
stop.

`@nx/enforce-module-boundaries` cannot express that second half: its
`notDependOnLibsWithTags` is **transitive**, and the tier depends on the kit by design, so
banning `ui:vendor-wrapper` from feature code also fails on every path through
`@trinity/components/*` — the very path it exists to bless. A direct-import rule is the right
shape, and it is the same one the `matrix-js-sdk` ban uses.

There are no named exceptions. `scripts/lint-invariants.spec.mjs` resolves the effective ESLint
configuration and scans feature/app sources, so weakening the glob or adding a direct Helm import
fails independently of ordinary lint.

That third tag is what makes the layering above enforceable rather than merely described.
Every UI library used to carry identical tags, so no boundary rule could say "only the kit may
import Brain" — they were indistinguishable to Nx. The public tier now carries `ui:public`,
the kit carries `ui:vendor-wrapper`, and `bannedExternalImports` keeps `@spartan-ng/brain`,
`@angular/cdk`, `@ng-icons` and `@ctrl/ngx-emoji-mart` out of every tier below the UI one.

Neither UI tag carries a vendor ban, and that is the whole shape: both **are** wrapper layers,
so banning their vendors would ban them from existing. There was a third tag, `ui:wrapper`,
which did carry all four — it belonged to `libs/ui`, and it was deleted with that library
rather than left behind, because a ban keyed on a tag no project carries enforces nothing
while reading as a closed door. `lint-invariants.spec.mjs` now fails on exactly that.

The ban reads TypeScript import specifiers and nothing else, so it is worth knowing where it
cannot see. `apps/trinity`'s build `styles` array names two vendor stylesheets directly —
`@angular/cdk/overlay-prebuilt.css`, without which no overlay positions at all, and
`@ctrl/ngx-emoji-mart/picker.css`. Both must load globally. The picker's _can_ be pulled into
its lazy component chunk (`@import '@ctrl/ngx-emoji-mart/picker'` resolves and inlines), but
that puts the component 517 bytes over the 8 kB `anyComponentStyle` budget, and widening a
budget that guards every component to relocate one vendored file is the worse trade. So the
two are pinned by `lint-invariants.spec.mjs` instead: a third has to be argued for there
rather than appearing in build config nobody reads as part of the boundary.

Composition is the other half of that containment. `hostDirectives` **is** public API — a
composed directive's input is bindable on our element only if the entry lists it — so every
entry in the kit states its `inputs`, even when the answer is `[]`. The shorthand
(`hostDirectives: [BrnFoo]`) exposes nothing, which is usually right but is a decision nobody
made, and it hides the opposite case equally well: `HlmInput` composed
`BrnFieldControlDescribedBy` without listing `aria-describedby`, so setting that attribute on
an `hlmInput` was silently overwritten with null and could not be set at all. The same is true of `outputs`, which Angular
validates and merges identically. All 43 entries state both, and
`scripts/host-directives.spec.mjs` fails on one that does not — which is also what a
`@spartan-ng/cli` regenerate would produce, so it is registered as a vendored divergence
below.

`type:feature` started with **103** violations across 60 files and is now at **zero**. #151
closed the 30 dialog and toast imports, #154 the 62 icon ones and #152 the last 11, so every
tier below the UI layer is enforced the same way: a new vendor import fails `pnpm lint`,
statically or through a lazy `import()`. Nothing is staged any more — the temporary `warn`
block that kept the count visible while it shrank is gone, which is what closing this gate
meant.

The emoji picker is the clearest case of what the vendor layer costs when it is not wrapped.
`@ctrl/ngx-emoji-mart`'s `picker.css` is 453 lines with **zero** custom properties — every
colour a literal — and its whole idea of theming is one `darkMode` boolean that toggles an
`.emoji-mart-dark` class. That cannot express Trinity's mode x palette grid, so the picker
rendered its own purple accent and its own greys under all four combinations.
`<trn-emoji-picker>` pins that boolean to `false` and paints the chrome from design tokens
instead, so it re-themes with everything else.

Two details there are easy to get wrong, and both are pinned by tests. The boolean has to be
**pinned**, not merely left unbound: the vendor defaults it to
`matchMedia('(prefers-color-scheme: dark)').matches`, so an absent binding follows the
desktop rather than switching the class off, and jsdom reports light — so a rendering test
will happily confirm an invariant that does not hold in a browser. And the **accent is
passed, not overridden**: the vendor emits it as an inline style on the anchor bar and the
selected category, which no rule in a stylesheet can outrank without `!important`, so
`var(--trinity-accent)` goes in through the vendor's own `color` input.

Icons are the clearest illustration of what the wrapper buys. `@ng-icons` types its `name`
as `IconName | (string & {})` — any string at all — so `name="lucideTrash"` (no `2`) used to
type-check, build, and render nothing. `<trn-icon>` takes a closed `TrnIconName` union
instead, so that is a compile error, and the vendor identifiers live in exactly one file.
Accessibility moved from incidental to systematic in the same step: `NgIcon` force-hides any
icon lacking a **static** `aria-hidden`, which silently suppressed a bound `aria-label` — a
label the quick switcher was announcing to nobody. `<trn-icon>` is decorative by default and
puts a `label` on its own host, where nothing can suppress it.

The grouped public entrypoints hold domain-neutral foundations, controls, generic content,
navigation/layout and overlays. The boundary rule is that `type:ui` may depend only on ui,
util and platform libraries — never on data-access, never on the SDK. Conversations owns
`MediaBubbleComponent` and `MessageToolbarComponent` because they render Matrix product concepts.

That rule is what forces the injection-token pattern. `<trn-avatar>` needs to turn an
`mxc://` URI into a displayable blob URL, which is a data-access concern, so it injects an
optional `AVATAR_RESOLVER` token that `main.ts` wires to `AvatarService.resolve`. When the
token is absent — `ui` in isolation, or a unit test — the component falls back to its `url`
input. Its typed `shape="person|place"` contract keeps users and DMs circular while rooms and
spaces use stable squircles; the radius is applied to Helm's host, image, fallback and outline
through one inherited custom property. Application Runtime uses the same inward-facing shape for
`ENCRYPTION_DIALOG_COMPONENTS`: the app supplies cold lazy Trust-page Observables without the
runtime importing `feature-crypto`. See [libraries](libraries.md) for the boundary rules in full.

## The Helm libraries are generated

`libs/spartan/*` is canonical spartan-ng Helm code produced by `@spartan-ng/cli`. Add or
regenerate a component with the CLI rather than hand-authoring it:

```bash
pnpm nx g @spartan-ng/cli:ui <name>
```

That is the whole workflow. The kit keeps upstream's own naming — `hlm` selectors, `Hlm*`
class names, the `@trinity/helm/*` alias — so a regenerate lands consistent with what is
already there and needs no post-processing step.

`trn` is reserved for Trinity's own code — `<trn-icon>`, `<trn-emoji-picker>` and the overlay
adapters — which is what makes the wrapper layer legible at a glance: an `hlm` name is
upstream's, a `trn` name is ours. Renaming the kit into that namespace was tried and rejected;
it would have needed a codemod re-applied after every generate, and a half-applied one **lints
clean** because the generated files are exempt from the selector and class-suffix rules.

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

Only `libs/spartan/tests` has a Vitest target; every other Helm library is build and lint only.
That is why the specs pinning Helm behaviour live there rather than beside the components they
cover, and import across the library boundary. That project holds nothing else — it exists so
those specs stay in the vendor tier now that the hand-authored libraries have left it.

!!! warning "Never assert on a Helm component's host class string"

    Helm styles its host through the asynchronous `classes()` manager in
    `libs/spartan/utils/src/lib/hlm.ts` — an `effect()` plus a document-wide
    `MutationObserver` that applies the merged class string on a microtask or
    animation-frame schedule. Asserting the applied host classes produces flaky specs.
    Assert the pure, synchronous `cva` functions instead (`buttonVariants`,
    `badgeVariants`) plus the fact that the component renders without throwing. This is
    stated as a rule in
    [`helm-components.spec.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/spartan/tests/src/lib/helm-components.spec.ts).

## The overlay library is Trinity code

`@trinity/components/overlay` is **hand-authored**, not generated — it sat under `libs/spartan/`
for historical reasons until it moved to the public tier with the icon and emoji-picker
wrappers. It holds the imperative overlay adapters:
`TrnDialogService`, `TrnAlertService` with `TrnAlertDialogComponent`, `TrnActionSheetService`
with `TrnActionSheetComponent`, public dropdown directives, `TrnToastService`, and the root
`TrnToasterComponent` — built on CDK Dialog and Overlay plus brain sonner. A modal'd component
closes itself with `inject(TrnDialogRef).close(data)`.

`TrnDialogRef` is Trinity's own class, not a re-exported `DialogRef`. That distinction is the
whole point of the layer: the barrel used to hand out CDK's class — one deliberate, documented
export — and that single line put `@angular/cdk` in the type signature of 24 feature
components, so swapping the dialog library would have meant editing every one of them. The
wrapper is two members wide (`close`, `closed`), which is everything the app used across 51
call sites, and `vendor-surface.spec.ts` asserts the barrel re-exports **no** CDK value at
all. Anything genuinely new should arrive as a named method on `TrnDialogService`, where it
can be given Trinity's semantics, rather than by widening this handle.

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

!!! warning "Keep sonner behind the public overlay tier"

    `<trn-toaster/>` owns Helm's toaster, which wraps brain's `<brn-sonner-toaster/>` and reads **brain's own**
    `toastState`. Since spartan 1.1 brain ships its own sonner port and no longer depends on
    `ngx-sonner`, so calling `ngx-sonner`'s `toast()` pushes into a store the mounted toaster
    never observes. The toast silently never appears — no error, no console output, nothing in
    the DOM. `TrnToastService` is the one place that imports the brain toast function, and
    `TrnToasterComponent` is the one public root viewport.

## `hostDirectives` is public API

A helm component composes a headless Brain directive through `hostDirectives`, and that entry
decides what a consumer may bind. **A composed directive's input is bindable only if the entry
lists it in `inputs: [...]`.** Anything not listed is not merely unavailable — if the composed
directive owns a host binding for it, the binding still runs and _overwrites whatever the
consumer set_.

That is not hypothetical. `hlmInput`, `hlmTextarea` and `hlmRadioGroup` each compose
`BrnFieldControlDescribedBy`, which owns `[attr.aria-describedby]`, and none of them published
the input. Every `aria-describedby` on those controls was computed as `null` and removed from the
DOM — silently, on three shipped screens, for as long as the components have existed.

**The rules:**

1. **Every `hostDirectives` entry lists `inputs` AND `outputs` explicitly**, even when the
   answer is `[]`. An empty list is a decision; an omitted one is an accident that publishes or
   swallows an API nobody chose. Angular validates and merges the two identically, so the same
   applies to both — `CdkMenu.closed`, for instance, stays internal by decision, because
   closure is already public on the trigger as `hlmDropdownMenuClosed` and two names for one
   lifecycle is easy to add and hard to withdraw.
2. **Set `aria-describedby` as an attribute or a property binding, never `[attr.aria-describedby]`.**
   Even with the input published, the attribute form is still overwritten: the directive's host
   binding runs after the template's. Pinned by a test in
   `libs/spartan/tests/src/lib/helm-components.spec.ts` so a future upstream fix is noticed.
3. **`hlm-checkbox` and `hlm-radio` are deliberately different.** Each declares its own
   `aria-describedby` input, forwards it to the inner `brn-*` control and nulls the host
   attribute, because the host is `display: contents` and is not the focusable element. That
   asymmetry is pinned by a test — do not "fix" it into describing the wrong node.

`hlm-select-trigger` still applies `brnFieldControlDescribedBy` to its inner `<button>` with
nothing bound, so `aria-describedby` remains unavailable. Trinity's registered override now
forwards `aria-labelledby` to that same button, which lets the public select wrapper name the
actual combobox while the description gap stays explicitly tracked.

## Registered vendored divergences

Local changes to generated Helm code. A regenerate silently drops all of them, so each is
commented at its site, listed in a banner at the top of its file, and **pinned by a test** —
a lost override fails the suite rather than shipping. This table is the register; keep it in
step with the banner in
[`hlm-dropdown-menu.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/spartan/dropdown-menu/src/lib/hlm-dropdown-menu.ts).

| File and symbol                                              | Override                                                                                                                                                                                                                                                                                                  | Pinned by                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `dropdown-menu` · `HlmDropdownMenuSubTrigger`                | `_handleClick` shadowed so a sub-trigger click opens the submenu instead of toggling it closed under zoneless change detection                                                                                                                                                                            | `dropdown-menu-submenu.spec.ts`                              |
| `dropdown-menu` · `HlmDropdownMenuSubTrigger`                | The same shadow re-does CDK's focus move, so keyboard Enter and Space land inside the submenu                                                                                                                                                                                                             | `dropdown-menu-submenu.spec.ts`                              |
| `dropdown-menu` · `HlmDropdownMenuSubTrigger`                | `side` defaults to `'right'`, so a submenu opens beside its parent rather than over it                                                                                                                                                                                                                    | `dropdown-menu-submenu.spec.ts`                              |
| `dropdown-menu` · `HlmDropdownMenu` and `HlmDropdownMenuSub` | `CdkTargetMenuAim` host directive                                                                                                                                                                                                                                                                         | `dropdown-menu-submenu.spec.ts`                              |
| `dropdown-menu` · `HlmDropdownMenuItem`                      | A destructive item's text and icon use `text-danger`, not upstream's `text-destructive`                                                                                                                                                                                                                   | `dropdown-menu-submenu.spec.ts`                              |
| `badge` · `badgeVariants`                                    | Adds `success` and `warning` variants that upstream Helm does not ship                                                                                                                                                                                                                                    | `helm-components.spec.ts`                                    |
| `tabs` · `HlmTabsPaginatedList`                              | Generated and then deleted — nothing wraps the scrolling trigger row, and it pulled `@angular/cdk/observers`, `@ng-icons/*` and the button lib in behind it                                                                                                                                               | `helm-components.spec.ts`                                    |
| `dropdown-menu` · `HlmDropdownMenu` and `HlmDropdownMenuSub` | Both `animate-in` / `animate-out` triggers carry `motion-safe:` — upstream ships them bare                                                                                                                                                                                                                | `kit-reduced-motion.spec.mjs`                                |
| `tooltip` · `DEFAULT_TOOLTIP_CONTENT_CLASSES`                | All three `animate-in` / `animate-out` triggers carry `motion-safe:`, including `data-[state=delayed-open]:`                                                                                                                                                                                              | `kit-reduced-motion.spec.mjs`                                |
| `select` · `HlmSelectContent`                                | Both `animate-in` / `animate-out` triggers carry `motion-safe:`                                                                                                                                                                                                                                           | `kit-reduced-motion.spec.mjs`                                |
| `select` · `HlmSelectTrigger`                                | Forwards `aria-labelledby` to the inner focusable combobox button instead of leaving it on a role-less wrapper, applies Trinity's coarse-pointer target floor to that button, and pins its foreground to the theme token                                                                                  | `trn-select.component.spec.ts`; Settings Playwright journeys |
| `progress` · `HlmProgressIndicator`                          | Its **indeterminate** sweep is guarded for reduced motion in Theme Foundation's private Tailwind adapter — the class is applied through a `[class.…]` binding, so the guard is a rule rather than a variant. The determinate `transition-all` is not covered and still rests on the `global.scss` blanket | `kit-reduced-motion.spec.mjs`                                |
| Every file with `hostDirectives`, kit and public tier alike  | Every entry states its `inputs` and `outputs` explicitly, even when empty — the generator's shorthand decides the element's public API by omission                                                                                                                                                        | `host-directives.spec.mjs`                                   |

The two `.spec.ts` files live in
[`libs/spartan/tests/src/lib`](https://github.com/quwisky/trinity-matrix-client/tree/develop/libs/spartan/tests/src/lib),
a project that exists so specs pinning vendored behaviour stay in the vendor tier now that the
hand-authored wrappers have moved to `libs/components/`. `host-directives.spec.mjs` is a
workspace-wide sweep and lives in `scripts/`.

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
[`libs/theme-foundation/styles/internal/tailwind-adapter.css`](../../libs/theme-foundation/styles/internal/tailwind-adapter.css),
which is **private framework wiring only** and owns no colour values:

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

Theme Foundation's supported stylesheet interface is the single aggregate
`libs/theme-foundation/styles/theme.scss`. The application and Storybook both load that aggregate
directly, after the app-wide global rules. Private token and Tailwind adapter files are implementation
details; compatibility stylesheet entrypoints outside Theme Foundation do not exist.

ESLint and Prettier point their Tailwind integration at Theme Foundation's private adapter, with
`classnames-order` off (`prettier-plugin-tailwindcss` owns ordering) and `no-custom-classname` off
(the app mixes BEM class names with utilities). The remaining ESLint rules are warnings.

!!! warning "inlineCritical must stay false in production"

    The production configuration pins `optimization.styles.inlineCritical: false`. Angular's
    critical-CSS inlining rewrites the stylesheet link into a preload with an `onload` swap,
    and that handler never fires under the custom `trinity://` protocol the Electron shell
    serves from. The token stylesheet never activates, every `var(--trinity-*)` falls back to
    nothing, and the desktop build renders unthemed. This is how the desktop dark theme broke
    once already.

## Design tokens

Every token value in the app is defined once inside Theme Foundation, in
[`libs/theme-foundation/styles/internal/variables.scss`](../../libs/theme-foundation/styles/internal/variables.scss).
Product styles consume the stable `--trinity-*` semantic vocabulary. Helm and Tailwind names
are private adapters inside the module; feature code never authors a Theme in vendor terms.

The module has two supported interfaces: the aggregate stylesheet above and the read-only
`THEME_CATALOG` exported from `@trinity/theme-foundation`. The catalog owns Theme and Mode ids,
labels, defaults, carrier metadata and the six fixed preview combinations. It contains CSS token
references for previewing but no resolved colour or shadow values.

A **Theme** is a named visual token set (`trinity`, `amethyst` or `onyx`); **Mode** is the
`system`, `light` or `dark` selection; **Appearance** is their composition with text size,
density and Conversations' code preferences. `Palette` remains only in temporary compatibility
names such as `ThemeService.setPalette()` and its persisted storage key while the migration is
expanded. Theme identity and selector metadata are read from `THEME_CATALOG` directly.

Theme authors may override only the catalog's governed semantic colour and elevation roles.
Fonts, assets, arbitrary selectors and component mappings are outside that contract. The default
`:root` Theme defines every governed role, `:root.dark` supplies the complete Mode delta, and each
named Theme adds one sparse light block and one sparse dark block. Named Themes never inherit from
one another.

### Orthogonal axes, all carried on `<html>`

| Axis              | Carrier                                                   | Default                                          |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------ |
| Mode              | the `.dark` **class** — presence means dark               | light, the bare `:root` block                    |
| Theme             | the `data-theme` **attribute**                            | `trinity`, which sets no attribute at all        |
| Text size         | an inline `font-size` **percentage**                      | 100%, written as no inline style at all          |
| Code size         | the `--trinity-code-scale` **custom property** (a factor) | `1`, declared in `variables.scss` and unset here |
| Code line numbers | the `data-code-lines` **attribute**                       | `auto`, which sets no attribute at all           |
| Density           | the `data-density` **attribute**                          | `cosy`, which sets no attribute at all           |

The canonical preference policy is split by capability: Design System owns Mode, Theme, text size,
and density in `@trinity/application/appearance`; Conversations owns code size and code-line
presentation in `@trinity/data-access/timeline`. Each installation-scoped descriptor has its own
closed validator, default, versioned `trinity.appearance.*` key, portable export policy, and editor
metadata. The six cells compose into one read-only Appearance value plus per-axis state without
moving persistence out of Preferences Store. Theme validation is derived from `THEME_CATALOG`, so
a removed Theme safely defaults only that axis and contributes to the aggregate's one recoverable
partial-hydration warning. Recovery writes defaults only for failed descriptors, then hydrates the
aggregate again; a healthy axis is never reset as collateral.

Resolved Appearance policy is platform-neutral. `resolveAppearance()` combines the six committed
axes with a system light/dark value, and `AppearanceEffects.run()` is the cold lifetime that owns
system-Mode observation and imperative projection. The browser document adapter alone owns every
root carrier in the table above. Native chrome receives only `{ mode }`, so Theme, sizing,
density, and code presentation never cross that boundary. A system colour-scheme change updates
resolved Appearance and native chrome only while committed Mode is `system`; an explicit light or
dark Mode keeps both inert. Application Runtime owns one effect subscription for its whole session,
after hydrating Appearance in the preference stage and before Workspace routing. Preference Store
publishes only successful writes, so rejected persistence never changes resolved or rendered
Appearance.

Settings consumes those six axes through one screen-scoped controller. Labels, descriptions and
options come from descriptor editor metadata; controls invoke descriptor-backed commands rather
than `ThemeService` setters. All six remain disabled until hydration settles, so a write cannot race
a current or predecessor-key read. A pending or failed command continues to render the committed value,
and failure adds an inline Retry beside that control. The screen displays one warning for partial
hydration and can restore only the affected defaults. The routed screen never starts another
hydration or effect lifetime; Application Runtime has already settled both before the route opens.

Application Runtime also composes the concrete integration ports. Capacitor status-bar projection
receives only resolved Mode, and widgets receive a read-only resolved Appearance projection. The
Advanced configuration registry exposes six `appearance.*` paths whose defaults, validation,
choices, current persistence keys, and commands come from the descriptors. The former
`trinity.theme`, `trinity.palette`, `trinity.text-scale`, `trinity.density`, `trinity.code-scale`,
and `trinity.code-lines` keys remain read-only predecessors and never appear in a portable export.
Portable format 2 also imports the six former version 1 Theme paths through a one-way mapping to
the current `appearance.*` entries; new exports contain only the current names.
`ThemeService` remains only as a removable compatibility implementation for the next contraction
slice. First paint remains the existing CSS-only splash; no inline bootstrap script is added. The
axes remain orthogonal: any Theme works in either Mode, and code size multiplies text size rather
than replacing it.

Density is the odd one in what it drives: rather than styling anything itself, it re-cuts
the `--trinity-space-*` scale, so any stylesheet already reading those tokens follows
without knowing the preference exists. `:root[data-density='compact']` is (0,2,0) — the
same tie with `:root.dark` the palette section below describes. The two do not overlap
today (mode re-cuts colour, density re-cuts spacing); a colour added to the density block,
or a spacing token to a mode block, would be decided by source order alone.

**Every axis writes nothing at its default.** An untouched app leaves no footprint on
`<html>` at all, so the stylesheet is the single definition of what "Default" means and
whatever the browser or a user stylesheet says still wins. Adding an axis means following
that rule too — `applyX()` removes the class/attribute/property rather than writing an
explicit default value.

The last two exist because a rendered message body cannot carry a preference itself: its HTML
is memoized per message and shared by every viewer (`sanitizedHtmlCache` in `message-view.ts`),
so anything per-user has to reach it through CSS. What the markup may carry is
content-derived only — a block records its own line count in `rows`, and the stylesheet
decides what to do about it.

### Seeing the tokens: Storybook

`pnpm storybook` serves one Storybook covering the whole `libs/components/*` tier
(`libs/components/storybook-host` is config only — the stories live beside the components they
document). The toolbar carries Theme, light/dark Mode and density. Its Theme and Mode choices come
directly from the read-only `THEME_CATALOG`; the preview loads the same aggregate stylesheet as the
application and derives all six fixed Theme/Mode combinations from the catalog rather than
maintaining a parallel matrix.

That is what it is for. A palette is meant to be a data change — a block of token overrides plus
a registry entry — and before this the only way to know that held was to launch the app and
navigate to every surface. **If a component looks wrong under a new palette, the token layer is
incomplete; that is a bug in the tokens, not in the theme.**

Stories are written per _state_ (default, hover, disabled, loading, empty, long content), not one
per component: the default is the state least likely to be broken. They are not a substitute for
a unit test — they are a substitute for launching the app and clicking to the one screen where a
control appears.

### Two token families

**Trinity tokens** (`--trinity-*`) are the app's own vocabulary, consumed directly by
hand-authored component SCSS.

| Group               | Tokens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface primitives  | Palette values: `--trinity-rail`, `--trinity-sidebar`, `--trinity-sidebar-header`, `--trinity-chat`, `--trinity-hover`, `--trinity-active`, `--trinity-divider`, `--trinity-surface`. Existing consumers keep working while feature phases migrate.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Semantic surfaces   | Component-facing aliases: `--trinity-surface-frame`, `-navigation`, `-navigation-header`, `-workspace`, `-panel`, `-raised`, `-floating`; `--trinity-border-subtle` / `-strong`. These point inward to the palette primitives, never the other way round.                                                                                                                                                                                                                                                                                                                                                                                            |
| Interaction states  | Paired `--trinity-state-{hover,pressed,selected,selected-hover,attention}-{surface,foreground}` roles, plus the paired `--trinity-status-neutral-*` recipe, `--trinity-focus-ring` / `-on-attention` / `-halo` / `-width` / `-offset`, and `--trinity-disabled-opacity`. A state is a pair so palette tuning cannot change its fill without its ink.                                                                                                                                                                                                                                                                                                 |
| Text                | `--trinity-text`, `--trinity-text-muted`, `--trinity-text-bright`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Brand               | `--trinity-accent`, `--trinity-accent-foreground`, `--trinity-green`, `--trinity-green-foreground`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Link                | `--trinity-link` — accent-coloured **text**. Split from `--trinity-accent`, which is a fill: a fill and a readable text colour cannot be the same value and both clear AA (blurple is 3.19:1 on the light row grounds). Every `color:` that reads as accent uses this; borders and backgrounds use the accent.                                                                                                                                                                                                                                                                                                                                       |
| Danger              | `--trinity-danger`, `--trinity-danger-solid`, `--trinity-danger-solid-foreground`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Radii               | Measurement scale: `--trinity-radius` (8px), `-sm` (4px), `-md` (6px), `-xl` (12px), `-pill` (9999px). Component roles: `--trinity-shape-control-radius`, `-container-radius`, `-overlay-radius`. Identity roles: `--trinity-shape-person-radius` (circle) and `--trinity-shape-place-radius` (squircle).                                                                                                                                                                                                                                                                                                                                            |
| Syntax              | eight `--trinity-syntax-*` roles plus `-plain`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Typography          | Measurement scale: `--trinity-text-xs` / `-sm` / `-base` / `-md` / `-lg`, each with matching leading. Semantic `--trinity-type-{caption,metadata,body,message,control,title}-{size,line-height,weight}` roles keep the three decisions together; metadata also exposes tabular-number treatment. The message role is 1rem with 1.5 leading, while smaller conversation chrome stays on the compact roles. Sizes remain in `rem`, so Appearance → Text size scales them.                                                                                                                                                                              |
| Spacing and density | `--trinity-space-1`…`-7` — a 4px rhythm (2, 4, 8, 12, 16, 24, 32). Shared components consume `--trinity-density-item-gap`, `-row-gap`, `-row-padding-*` and `-control-size`; the room shell adds `-shell-gap`, `-shell-padding-inline` and `-channel-padding-block`, while the conversation adds `-message-column-gap` and `-composer-{padding-inline,field-gap,field-inset,action-size}`. Compact re-cuts these while `--trinity-interaction-target-min-size` enforces the global 44px coarse-pointer floor. Member rows and role headers deliberately do not use vertical density roles: their fixed 44px/34px boxes are inputs to virtualization. |
| Scrollbars          | `--trinity-scrollbar-size`, `-radius`, `-thumb` and `-track` apply the former room-container treatment to every visible vertical and horizontal scrollbar. The thumb aliases the active palette's `--trinity-rail`; Blink/WebKit use the fixed 8px rounded geometry, while Firefox shares the rail colour with its platform-defined `thin` geometry.                                                                                                                                                                                                                                                                                                 |
| Elevation           | `--trinity-shadow-raised` / `-floating` / `-overlay`. Overridden per mode: a shadow tuned for white is invisible on `#313338`, so dark raises the alpha.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Protocol media      | `--trinity-qr-surface` is the palette-invariant light quiet zone around QR modules. It is deliberately not a general card/background role.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Z-index layers      | `--trinity-z-sticky` (5) → `-floating` (10) → `-overlay` (20) → `-panel` (40), plus `-feedback` (10000) for the transient unavailable-action reason that must remain visible above a CDK dialog. **App-level only** — a component stacking its own children is local and stays a literal. The CDK overlay container sits at 1000.                                                                                                                                                                                                                                                                                                                    |
| Motion              | `--trinity-duration-press` for the down response and `-fast` / `-base` / `-slow` for transitions, plus `--trinity-duration-pulse` / `-flash` for motion that is not one (an ambient loop, a one-shot cue). `--trinity-ease-standard` / `-decelerate` / `-accelerate`. All collapsed to 0.01ms under `prefers-reduced-motion` at the bottom of `variables.scss` — which is why a literal duration is a bug, not a style. An `infinite` animation needs `global.scss`'s `animation-iteration-count` too: collapsing its duration alone makes it repeat per frame rather than stop.                                                                     |

Settings is the worked feature-level composition of these roles. Web and Electron mount its bounded
workspace in a CDK dialog; the installed mobile apps and direct deep links mount the same section
registry in the routed shell. The directory remains scrollable with a hidden gutter while the
detail pane is the one painted scroll owner. Paint containment on both shells prevents a long
detail from enlarging the document's root scroll extent.

Visible scrollbars are styled once in `apps/trinity/src/global.scss`; components own only
their overflow behavior and must not restate scrollbar paint. The `.no-scrollbar` utility is
the narrow exception for a scrollable surface whose bar would duplicate nearby chrome, such as
the Settings directory and select panels. It hides only the marked scroller, not nested overflow
surfaces, and must never be used to remove scrolling itself.
`SettingsSectionHeadingComponent` and `SettingsToggleRowDirective` keep sentence-case type and
density consistent without weakening native heading, label or switch semantics. The Appearance
preview is intentionally feature-local and token-only: it demonstrates the same surface, identity,
type and density roles without importing the room feature or duplicating theme values.

**Helm and shadcn tokens** (`--background`, `--card`, `--primary`, `--muted-foreground`,
`--border`, and the rest) are consumed by the generated Helm components through Tailwind
colour utilities.

Where a Helm token always equals a Trinity token it is defined **as a reference**, so a
palette only has to set the value once:

```scss
--card: var(--trinity-sidebar);
--primary: var(--trinity-accent);
--ring: var(--trinity-focus-ring-halo);
--input: var(--border);
```

The opaque focus role deliberately resolves to the measured link colour rather than the accent
fill. The fill drops below the 3:1 non-text threshold on some dark interactive surfaces. Attention
surfaces override it with `--trinity-focus-ring-on-attention`, whose value is paired to that fill.
Helm controls draw a 50%-alpha halo, so `--trinity-focus-ring-halo` supplies black in light mode and
white in dark mode; the browser suite measures the composited halo rather than trusting its source
colour. Every focus recipe is checked against its semantic surface across all palettes and modes.

Mode-invariant bindings are declared once in the base `:root` block. Three palettes ship:
`trinity` (blurple `#5865f2`), `amethyst` (violet) and `onyx` (achromatic; dark is AMOLED
true black).

`onyx` is worth reading as the worked example of the contract: it overrides **surfaces only**.
Every text role, the link, the danger colours, the accent and the whole syntax set are left
unset and fall through to the `:root` / `:root.dark` defaults — and `contrast-matrix.spec.mjs`
picks the palette up automatically and proves those inherited values still clear AA against the
new grounds, which is exactly where an inherited colour is most likely to stop working. A
palette that needed a component edited, or a role redefined to stay legible, would be telling
you the token layer is incomplete.

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

Theme Foundation's private Tailwind adapter maps
`--color-danger: var(--trinity-danger)`, which is what makes the `text-danger` utility exist.

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
    the surface is already dark enough in light mode to push the label under AA.

    Nothing was actually failing: every destructive control today is a dropdown-menu item,
    which renders on `--popover`, or a button on `--card`. What was wrong is that the trap
    was invisible — putting one on the sidebar or the room list would have shipped a sub-AA
    label with nothing to catch it, and the token comment positively invited that by claiming
    the red cleared 4.5:1 "on every tint".

    So the tint is pinned **opaque**, as `--trinity-danger-tint-*` mixed over `--card` — `in
    srgb`, which reproduces the composited pixels exactly, rather than `in oklab`, which does
    not. The tokens are named by percentage rather than by role because Helm's strengths are
    per-component, not per-state. Every destructive control now reads at the value the card
    was measured at wherever it is placed, so the check that matters is that the ratio is
    *the same on every surface*, not merely above 4.5 on the one you happened to try.

`--destructive` itself is left alone and stays the border and ring source, and the colour the
tint is mixed from. That is exactly what the token is for.

#### The unlayered override, and how to regenerate its selector list

Helm paints destructive controls as `bg-destructive/10..30` with `text-destructive` on top:
one token serving as both the tint and the ink drawn on it. That is unfixable by retoning
`--destructive`, because the tint _is_ the text colour diluted — every red that clears 4.5:1
against its own 20% tint is above 90% lightness, which is a pale pink that no longer reads as
danger.

So Theme Foundation's private Tailwind adapter decouples the roles with **unlayered** rules.
Tailwind emits utilities into `@layer utilities`, and unlayered declarations outrank every
cascade layer, so this wins without a specificity war.

!!! warning "The selector list must cover every emitted variant"

    An unmatched variant does not degrade gracefully — it produces a *half-styled* control: a
    legible "Leave room" label beside an icon still sitting at roughly 1.3:1. The dropdown
    menu colours its child icon through a **separate** rule targeting the `ng-icon`
    descendant, so fixing the item alone leaves the glyph behind.

    After running the spartan CLI, re-derive **both** lists mechanically from the built CSS
    rather than by reading Helm's class strings — there are two, one for the text and one for
    the opaque tint, and each must cover every emitted variant:

    ```bash
    pnpm nx build trinity
    tr '}' '\n' < www/styles-*.css | grep 'text-destructive.*color:var(--destructive)'
    tr '}' '\n' < www/styles-*.css | grep 'bg-destructive'
    ```

    The tint list has one extra thing to match: Helm gates most of its hover variants behind
    `@media (hover: hover)` so a touchscreen paints no hover tint, and an ungated override
    would reinstate one on the sticky `:hover` that follows a tap. Mirror the gating each
    rule actually has — the button's own `hover:bg-destructive/20` is emitted *ungated*,
    while `[a]:hover:` and the `data-[variant=destructive]` pair are not.

### Syntax-highlighting tokens are measured, not picked

Eight roles colour fenced code blocks, consumed from exactly one place —
`rendered-markdown.scss`, on the `tok-*` classes the highlighter emits. The role names must
stay in step with `TOKEN_ROLES` in
[`code-highlight.ts`](https://github.com/quwisky/trinity-matrix-client/blob/refactor/refine-architecture/libs/feature/rooms/src/lib/message-presentation/code-highlight.ts).

The backdrop is `--trinity-rail`, not the chat canvas — that is the `pre` background — and
every value clears 4.5:1 against it in both shipped palettes (worst case 4.61:1 light,
5.16:1 dark). The light set is One Light's hues _darkened until they passed_; the published
values sit at 2.5–3.8:1 on this rail and are not usable as body text. One Dark's values pass
unchanged. `-plain` and `-punctuation` are `var()` references to `--trinity-text` and
`--trinity-text-muted`, so they follow the mode automatically.

A new palette inherits all eight, and nothing checks them. If your rail departs from
`#e3e5e8` or `#e7e2f0` (light) or `#1e1f22` or `#1c1826` (dark), re-measure.

Highlighting itself is Shiki with thirty-one statically imported grammars — the chunk they
land in measures 3.5 MB raw and 513 kB gzipped, against 1.6 MB / 315 kB for the thirteen it
started with. Grammar payload dominates that chunk and compresses worse than application
code, so a language is not free: `cpp` alone is 521 KB raw, larger than the original thirteen
combined, which is why it is deliberately absent. Measure before adding one —
`gzip -c www/chunk-*.js | wc -c` on a production build, before and after, taking the largest
chunk each time.

The module is private to the Conversations feature and imported relatively for side effect at
the top of `rooms.page.ts`, so the grammars land in the lazy rooms chunk. It registers the
highlighter used by Message Presentation before the first timeline projection. Do not export it
from a public barrel: that would make it possible for an eager consumer to pull every grammar into
the initial bundle.

## Adding a Theme

Two steps.

**1. Add two CSS blocks in Theme Foundation's internal `variables.scss`**, copying the
`amethyst` pair:

```scss
:root[data-theme='<id>']:not(.dark) {
  // overrides for light
}

:root[data-theme='<id>'].dark {
  // overrides for dark
}
```

Override only what differs; anything omitted falls through to `:root` or `:root.dark`. Every
declaration must be one of the semantic color or elevation roles listed by
`THEME_CATALOG.authoring`. A Theme must not name Helm/Tailwind tokens, component selectors,
fonts, assets, or arbitrary CSS. Those are private implementation details, and the Theme
Foundation contract tests reject them inside named-Theme blocks.

The private adapter maps Helm/Tailwind roles outward from the Trinity semantic roles, so those
consumers re-theme automatically. For example, a light accent must pair its
`--trinity-accent` override with a measured `--trinity-accent-foreground`; Amethyst dark uses
dark on-accent text because white on its light violet accent would fail WCAG AA. Theme authors
never override `--primary` or `--primary-foreground` directly.

**2. Register the Theme** in `THEME_CATALOG` so its identity, label and absent-default carrier
are shared by Appearance and preview consumers:

```ts
const themes = Object.freeze([Object.freeze({ id: 'trinity', label: 'Trinity', dataTheme: null }), Object.freeze({ id: 'amethyst', label: 'Amethyst', dataTheme: 'amethyst' })]);
```

The compatibility `setPalette()` method writes or removes the `data-theme` attribute; the default
Theme applies no attribute at all.

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

!!! note "Two specs check that a consumed token resolves"

    A `var(--x)` with **no fallback** whose custom property is undefined makes the browser drop
    the whole declaration — the page still renders, just wrong, with nothing logged. Stylelint
    cannot see it: the `custom-property-pattern` in `.stylelintrc.json` constrains how a token is
    *named*, and nothing there resolves one across files.

    `scripts/token-resolve.spec.mjs` does. It collects every `var(--trinity-…)` in `libs` and
    `apps` — stylesheets, templates and TypeScript — and fails on any token nothing defines. It
    was written from a shipped bug: the mobile account picker asked for `var(--trinity-radius-lg)`,
    which no palette defines, so the declaration was invalid and the dialog rendered with square
    corners. The base 8px token is `--trinity-radius`; the private Tailwind adapter *does* define
    a Tailwind `--radius-lg`, but that is a different namespace and would not have helped.

    `scripts/contrast-matrix.spec.mjs` checks the other half — that a token which resolves is
    also readable. It measures every text role against every surface it can land on, per palette
    × mode, including the nine `--trinity-syntax-*` colours against `--trinity-rail`. A palette
    that retunes a ground now passes or fails instead of needing to be re-measured by hand.

    Both are one-directional on purpose: they fail on a token that is used and never defined, and
    say nothing about one that is defined and unused, because a palette block legitimately
    defines the whole vocabulary whether or not today's components reach for all of it.

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
toolbar floats across the row's upper trailing boundary, so a top-right caption can land
underneath it on a continuation row. Using generated content also keeps the caption out of
the element's text, so it cannot be selected, copied, or picked up by the edit-history diff.

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
- Component SCSS declares overflow but leaves visible scrollbar paint to the global token
  contract. Use `.no-scrollbar` only for an intentional hidden-bar exception.

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

Capability callers issue a typed, cold
`WorkspaceApplicationSurfaceService.open()` command; the app-level Workspace adapter owns lazy
loading and maps semantic return destinations to routes only at that boundary. Web and Electron
present Settings as a lazy dialog while installed Capacitor hosts use `/settings`; Trust unlock
and verification use dialogs on wide/nested placements and their canonical routes otherwise.
Both loaders are cold Observables. A failed load leaves the current route intact and reports an
error; navigation invalidates pending presentation, identical opens coalesce, and a second
unrelated surface cannot stack over an active one. Security and Devices can force nested Trust
flows to remain modal in a narrow web drill-in.

Toasts render through a single `<trn-toaster/>` mounted in `ApplicationRootComponent`. While CDK marks the app
root `aria-hidden` for a modal, `TrnToastService` mirrors new messages through CDK's body-level
`LiveAnnouncer`; outside a modal Sonner owns the announcement, avoiding duplicate speech.
