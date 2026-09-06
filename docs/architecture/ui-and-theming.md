# UI and theming

Use this guide when adding or changing a Trinity screen, public component,
theme, overlay, rendered message style, or vendor wrapper. Follow the path in
order: choose the public API, compose it with the right semantics, apply
governed tokens and responsive behaviour, then prove the rendered result.

The [design-system ledger](../../architecture/design-system.json) and
[generated dependency map](generated/dependency-map.md) are the current
ownership records. The ledger requires one public entrypoint for each
ui:public category, rejects broad export barrels and migration exceptions, and
marks the Storybook host as non-consumable. Run the architecture contract after
changing a public surface.

## Shared settings presentation

`TrnSettingsLayoutComponent` in the public overlay tier owns the common Settings,
Room settings, Space settings and System Status dialog presentation: overlay frame, header controls, optional
context/warning slots, section navigation and one scroll region per pane. It does not own
routing, Account identity, drafts or dismissal. Responsive geometry follows the surface's
`data-trn-layout` attribute, while compact pane geometry follows the separate `data-compact`
attribute, so surface treatment and compact reconciliation cannot retain stale state after
resizing. Its optional `settings-directory-header` slot
places consumer-owned controls inside the existing directory scroll region. Application Settings
uses it for directory search, owning the query and filtering the section registry; Room and Space
settings keep their existing unfiltered directories. The feature adapters supply those responsibilities
and retain their existing focus and Workspace Back lifetimes.

The dialogs use `textScaledViewportSignal(48, destroyRef)` for both navigation and presentation.
Unlike CSS media-query rem units, this follows the current root font-size preference as well as
viewport resizing. Compact dialogs open their directory unless an explicit section is requested.
Room/Space forms use the same section typography and grouping, preserve per-field permissions and
retained read-only drafts, and show sticky section actions only for pending edits.

System Status uses the same public layout without importing a Settings feature. Its desktop
directory and detail pane share the application-owned status catalogue, while the directory lists
only actionable capability groups plus Overview and Support details. Overview is the initial detail
on every surface; on compact surfaces Back moves from detail to the directory and then dismisses
through the shared Host Back owner. A selection that disappears returns to Overview, while a still
valid selection is retained. The `compact` pane geometry follows text scaling and viewport size;
the optional `surfaceLayout="sheet"` selects the native mobile sheet independently, so the sheet
choice is made from the operating system rather than pointer capability.

## 1. Choose the owner before writing UI

Trinity has four UI layers.

| Layer             | Location                                         | Owns                                                          |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Brain             | installed Spartan and Angular CDK packages       | headless behaviour, positioning, and accessibility primitives |
| Helm              | libs/spartan, imported as @trinity/helm          | generated styled vendor wrappers                              |
| public components | libs/components, imported as @trinity/components | domain-neutral Trinity APIs                                   |
| features          | libs/feature                                     | product screens and product-specific presentation             |

Features use the five public component categories:

| Entry point                           | Use for                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------- |
| @trinity/components/foundations       | icons and composable UI utilities                                          |
| @trinity/components/controls          | buttons, fields, labels, inputs, choices, and rich controls                |
| @trinity/components/generic-content   | avatars, banners, progress, empty states, and other domain-neutral content |
| @trinity/components/navigation-layout | page hierarchy, tabs, cards, separators, and navigation surfaces           |
| @trinity/components/overlay           | dialogs, sheets, menus, anchored layers, alerts, and notifications         |

A feature may keep presentation that is product-specific: message toolbars,
media bubbles, virtualized timelines, Room rows, and their geometry belong with
Conversations. Application Runtime owns application-surface loading. Do not
move either into a generic component merely because it appears in more than one
screen.

Features never import Helm, Brain, CDK, icon-vendor, emoji-vendor, or
matrix-js-sdk packages directly. A component needs to cross a domain boundary
through a public data-access API or an application port, not a private vendor
or feature import. The lint and architecture contracts enforce this boundary;
the [public ledgers](../../architecture/design-system.json) and
[entrypoints](generated/dependency-map.md) show the supported imports.

### Select an existing recipe

The recipe vocabulary is runtime data in
[foundations](../../libs/components/foundations/src), so a component publishes
a strict subset of the Trinity vocabulary instead of accepting arbitrary
classes or a vendor variant. Structural choices are separate from semantic
treatment.

| Public API                                                       | Supported vocabulary                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| trnBtn                                                           | variant primary, secondary, danger; size xs, sm, md, lg; presentation solid, outline, ghost, link; shape label or icon |
| trnIconButton                                                    | purpose-built icon control whose product geometry matters; it retains shared interaction states                        |
| trn-checkbox, trn-switch, trn-radio-group                        | neutral or accent; sm or md; native checked, indeterminate, invalid, disabled, and keyboard states                     |
| trnToggle, trn-toggle-group                                      | neutral or accent; sm, md, lg; plain or outline; joined or separated arrangement where offered                         |
| trnInput, trnTextarea                                            | sm, md, lg, with native invalid state                                                                                  |
| trn-select                                                       | sm or md, with invalid and disabled state on its actual combobox trigger                                               |
| trn-field and labels                                             | one native control with label, description, and invalid state; label emphasis normal or strong                         |
| trn-tabs                                                         | neutral or accent; pill or line; orientation and activation stay headless behaviour                                    |
| trn-page-header                                                  | neutral or accent; page or toolbar layout; one page-level h1                                                           |
| trnCard and trnSeparator                                         | neutral or muted cards; sm or md; semantic sections and headings remain at the call site                               |
| trn-icon                                                         | 2xs through 2xl; neutral, accent, muted, or danger                                                                     |
| trn-avatar                                                       | named 2xs through 2xl sizes; exactSize is a bounded 16–256 px escape hatch                                             |
| trnBadge, trn-banner, trn-empty-state, trn-progress, trn-spinner | only their exported semantic status and ordinal-size subsets                                                           |
| trnTooltip                                                       | top, right, bottom, or left positioning                                                                                |
| overlay surfaces                                                 | exported semantic variant, size, and structural layout only                                                            |

Do not use Helm-shaped button values such as default, destructive, or icon-sm.
Callers express product intent with Trinity variants, ordinal sizes, and shape.
A public component may expose only the subset it can render faithfully; the
strict template tests are intended to reject retired aliases and unsupported
values.

For a standard square icon action, use trnBtn with shape icon. Use
trnIconButton only when its geometry itself carries product meaning, such as a
reaction chip, server-rail pill, avatar action, or compact toolbar action.
In either case select explicit icon motion from the public contract. Motion
must never change the hit target, and reduced-motion mode removes the transform
while retaining focus and colour feedback.

A feature composes named public exports; it does not import a Helm directive to
reach the same result. In an existing standalone component, add the imports and
metadata below, then keep the markup in its external template. This uses the
public `trnBtn` recipe and closed icon name rather than a vendor class or icon
identifier.

**TypeScript imports and existing `@Component` metadata:**

```ts
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnButton } from '@trinity/components/controls';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnIconComponent],
  templateUrl: './send-action.component.html',
})
```

**`send-action.component.html`:**

```html
<button type="button" trnBtn variant="primary" size="md">
  <trn-icon name="send" size="sm" />
  Send
</button>
```

## 2. Compose semantics, accessibility, and layout

Start with native HTML. Checkboxes, switches, and radios keep native inputs;
their recipe-owned visual spans are not a replacement for browser or assistive
technology state. Labels preserve their for and id relationship, and native text controls use
aria-describedby for descriptions. A select routes aria-labelledby and invalid
state to its real combobox button; it does not forward aria-describedby. A
component must not encode a visible label in a host aria-label by default; the
caller knows the label in context.

Use semantic structure around public chrome. The caller owns a card's section
and heading semantics, a separator's announced or decorative role, and a
screen's hierarchy. The component owns its recipe spacing, shape, colour,
elevation, focus, hover, pressed, disabled, and invalid states. Do not add an
arbitrary class-string input to change an inner public component.

An icon-only control needs an accessible name. Set `aria-label` on the button
and pair it with a matching trnTooltip; the tooltip describes the control but
does not supply its accessible name. Do not use a native title, so the surface
follows Trinity tokens and works consistently. `trn-icon` is decorative by
default; set its `label` only when the glyph itself supplies the name. Set its
`size` input rather than a `text-*` class when it must be larger than inherited
text, because the wrapper
sets the vendor glyph's measured size. A vertically stacked navigation or
member label opens sideways so its hoverable overlay cannot cover the preceding
control.

### hostDirectives are public API

An Angular composed directive publishes an input or output only when its
hostDirectives entry lists it. Every generated Helm entry therefore states
inputs and outputs explicitly, including empty arrays. Shorthand silently
publishes neither.

When composing an existing directive:

1. list every supported input and output in the hostDirectives entry;
2. keep unsupported vendor inputs private;
3. set aria-describedby as a property binding (`[aria-describedby]`) or a
   bare attribute (`aria-describedby`), never `[attr.aria-describedby]`, where
   the field-control directive owns the attribute;
4. add or update the strict-template and behaviour proof for the public API.

The [hostDirectives contract](../../scripts/host-directives.spec.mjs) protects
this rule. The input and textarea wrappers demonstrate the required
aria-describedby publication in
[TrnInput](../../libs/components/controls/src/lib/input/trn-input.ts) and
[TrnTextarea](../../libs/components/controls/src/lib/textarea/trn-textarea.ts).

### Responsive interaction and safe areas

Use the predicate that answers the actual question. Mobile OS chooses the
interaction model; a coarse pointer chooses touch target size. A touch-enabled
desktop is not a mobile OS. Keep responsive placement semantic: a narrow
presentation can move a surface into a sheet without creating a second route
or state owner.

Use the shared safe-area helpers with their padding in one declaration. A
safe-area utility and another padding utility write the same longhand and one
replaces the other. Keep consumer geometry in its feature stylesheet, and
leave public recipe internals to their owner. The Rooms
[shared mixins](../../libs/feature/rooms/src/lib/styles/_mixins.scss) remain
available for content layout, including the parameterless dialog-surface mixin.
It does not own dialog width, surface paint, or chrome: consumers compose the
public overlay-surface recipe for those.

Keep trn element selectors kebab-case and directive selectors camelCase; class
names end in Page or Component. A component remains a directory with TypeScript,
template, SCSS, and spec files. Preserve data-testid hooks on interactive
elements. Shared mixins cover layout only; hardcoded colours, a second
scrollbar-paint contract, or a component-level vendor selector do not belong
there.

A component stylesheet is unlayered unless it declares a layer. Tailwind
utilities are in the utilities layer, so an unlayered component declaration
wins regardless of selector specificity. Put authored public component rules in
the components layer and do not try to fix a cascade problem with specificity
or an important escape. The
[cascade contract](../../scripts/cascade-layer-contract.spec.mjs) records the
governed order.

## 3. Use the generated vendor layer correctly

Helm libraries under libs/spartan originate from the Spartan CLI. Do not
hand-author a vendor component. Add a missing primitive through the
repository-supported CLI path; for an installed wrapper, compare an isolated
upstream generation before carrying forward each registered Trinity divergence.

Helm may use Brain and vendor packages because it is the wrapper layer.
Public components may compose Helm but export only Trinity names and types.
Features consume public components, never Helm. The global vendor CSS seam is
a deliberate exception for CDK overlay positioning and the emoji picker; do
not add another global vendor stylesheet without updating its explicit
contract.

Never assert an implementation component's host class string. Test its
Trinity public API, DOM semantics, and rendered behaviour instead. Only the
Spartan tests project is a generated-tier Vitest target; other generated
libraries are checked through their declared build and lint targets.

### Vendored divergences

A divergence from generated Helm must be narrow, explained at the source, and
registered below. It needs a test that pins the behavioural reason, so
regeneration cannot erase it silently. Do not use a divergence to add product
state, a feature import, or a new public vendor-shaped API.

Generate only a missing supported primitive through the installed CLI; its `ui`
schema takes a primitive `name`, plus optional `directory` and `tags`. From this
repository, use the full existing project tag set:

```bash
pnpm nx g @spartan-ng/cli:ui <name> --directory libs/spartan --tags type:ui,scope:shared,ui:vendor-wrapper,role:design-system,capability:design-system
```

The root [components.json](../../components.json) supplies the `libs/spartan`
path, `@trinity/helm` import alias, `nova` style, and library generation shape.
The generator skips an installed primitive alias, so this command does not
regenerate or update existing wrappers. For an upstream update, create an
isolated generated comparison, inspect the narrow diff against the installed
wrapper, then manually preserve each registered divergence and its proof. Do
not bulk-delete or overwrite the vendor layer. Do not run the generator merely
to inspect it.

#### Vendored spartan overrides

| Source owner                                                                                   | Intentional divergence                                                                                                                                                                                                                                                                   | Proof to read or update                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [avatar](../../libs/spartan/avatar/src/lib/hlm-avatar.ts)                                      | `HlmAvatar`, image, and fallback inherit Trinity's semantic shape: a person is a circle and a place is a squircle, rather than every avatar becoming a circle.                                                                                                                           | [Theme Foundation contract](../../scripts/theme-foundation-contract.spec.mjs) and browser shape coverage                                            |
| [dropdown menu](../../libs/spartan/dropdown-menu/src/lib/hlm-dropdown-menu.ts)                 | `HlmDropdownMenuSubTrigger` opens its submenu, restores the CDK focus move, and defaults to logical right placement; menu aim remains attached to root and submenus.                                                                                                                     | [submenu spec](../../libs/spartan/tests/src/lib/dropdown-menu-submenu.spec.ts)                                                                      |
| [dropdown menu](../../libs/spartan/dropdown-menu/src/lib/hlm-dropdown-menu.ts)                 | `HlmDropdownMenuFocusOnHover` moves the active DOM focus on real mouse hover, while ignoring touch-generated hover and disabled items, so the CDK menu keeps one active item.                                                                                                            | [submenu spec](../../libs/spartan/tests/src/lib/dropdown-menu-submenu.spec.ts)                                                                      |
| [dropdown menu](../../libs/spartan/dropdown-menu/src/lib/hlm-dropdown-menu.ts)                 | A destructive menu row uses `text-danger` for readable ink, while destructive remains a fill/tint role.                                                                                                                                                                                  | [submenu spec](../../libs/spartan/tests/src/lib/dropdown-menu-submenu.spec.ts)                                                                      |
| [badge](../../libs/spartan/badge/src/lib/hlm-badge.ts)                                         | Badge adds success and warning status recipes and uses the invariant `rounded-full` shape.                                                                                                                                                                                               | [Helm component spec](../../libs/spartan/tests/src/lib/helm-components.spec.ts)                                                                     |
| [select](../../libs/spartan/select/src/lib/hlm-select-content.ts), dropdown, tooltip, progress | Overlay elevation uses `shadow-overlay`; radio/tabs use `shadow-raised`; open/close and indeterminate animation carries a local reduced-motion guard.                                                                                                                                    | [Theme Foundation contract](../../scripts/theme-foundation-contract.spec.mjs) and [reduced-motion guard](../../scripts/kit-reduced-motion.spec.mjs) |
| [select trigger](../../libs/spartan/select/src/lib/hlm-select-trigger.ts)                      | The source-bannered divergence forwards `aria-labelledby` and explicit invalid state to the real combobox button, supplies its readable foreground, and enforces the shared 44px coarse-pointer target floor. `aria-describedby` is deliberately unavailable through the public wrapper. | [public select spec](../../libs/components/controls/src/lib/select/trn-select.component.spec.ts)                                                    |
| [tabs entrypoint](../../libs/spartan/tabs/src/index.ts)                                        | `HlmTabsPaginatedList` is intentionally deleted: no public Trinity surface needs its scrolling trigger row or its extra observer, icon, and button dependencies. Reintroduce it only with a public need and a regenerated, reviewed tabs wrapper.                                        | [Helm component spec](../../libs/spartan/tests/src/lib/helm-components.spec.ts)                                                                     |
| [Sonner wrapper](../../libs/spartan/sonner/src/lib/hlm-toaster.ts)                             | A semantic adapter repairs the vendor list/live-region structure rather than changing the public toaster API.                                                                                                                                                                            | [toast render spec](../../libs/components/overlay/src/lib/toast/trn-toast-render.spec.ts)                                                           |
| every Helm component                                                                           | Every `hostDirectives` entry declares inputs and outputs explicitly.                                                                                                                                                                                                                     | [hostDirectives guard](../../scripts/host-directives.spec.mjs)                                                                                      |

Read the nearby source and its proof before changing one of these areas. The
registry is a contract, not a menu of optional styling preferences.

## 4. Style with tokens and the cascade

Theme Foundation owns the aggregate stylesheet, the semantic token catalogue,
and the private Tailwind and Helm adapters:

- [theme stylesheet](../../libs/theme-foundation/styles/theme.scss)
- [base variables](../../libs/theme-foundation/styles/internal/variables.scss)
- [private Tailwind adapter](../../libs/theme-foundation/styles/internal/tailwind-adapter.css)
- [Theme catalogue](../../libs/theme-foundation/src/lib/theme-catalog.ts)

Feature and component SCSS consumes Trinity semantic tokens. It does not
author Helm or Tailwind token names, hardcoded colours, vendor classes, raw
elevation, or a Theme-specific selector. A token must represent a semantic
role, not a component name.

### Token families

| Family               | Examples and rule                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| surfaces and borders | frame, navigation, workspace, panel, raised, floating, drop overlay, subtle and strong borders                                                    |
| text                 | `--trinity-text`, `--trinity-text-muted`, `--trinity-text-bright`, `--trinity-link`, and semantic status text                                     |
| accent               | `--trinity-accent`, `--trinity-accent-hover`, `--trinity-accent-foreground`, tint stops, and link; fill and readable text are separate roles      |
| status               | `--trinity-success`, `--trinity-warning`, and `--trinity-danger` text/icon roles; `*-solid` fills and `*-solid-foreground` ink; opaque tint ramps |
| shape and elevation  | radius and spacing roles; `--trinity-shadow-raised`, `--trinity-shadow-floating`, and `--trinity-shadow-overlay`                                  |
| interaction          | focus, hover, pressed, selected, selected-hover, disabled, and semantic state roles                                                               |
| layering             | app-level sticky, floating, overlay, panel, and feedback layers; local component stacks remain local literals                                     |
| syntax               | the eight syntax roles consumed only by rendered markdown                                                                                         |

Visible scrollbar paint is global. A component owns its overflow behaviour but
does not restate scrollbar colours. The no-scrollbar utility hides an
intentionally chosen scroller; it must never remove scrolling itself.

All Theme-authored colours use in-gamut absolute `oklch()` coordinates. The
contrast guard rejects legacy colour notation, runtime colour mixing, and values
outside sRGB because browser gamut mapping would make a claimed contrast ratio
host-dependent. Named Themes override only their sparse semantic colour and
elevation roles; they inherit the remaining roles from the base Theme.

### Danger is not destructive

> [!WARNING]
> Never use Helm `text-destructive` as a foreground colour. In templates use
> `text-danger`; in SCSS use `var(--trinity-danger)` for text or icons.

Destructive is a fill and ring contract paired with its destructive foreground.
Trinity danger is the readable text and icon role on a surface. A filled danger
badge uses the dedicated danger-solid pair. Never use a translucent destructive
tint as a contrast guarantee: the surface beneath it changes the resulting
pixels. The private adapter replaces destructive opacity utilities with
explicit opaque danger tint stops and its override list must cover every
emitted button, menu, descendant-icon, hover, and data-variant selector.

After regenerating Helm or changing a destructive recipe, build the web
artifact and derive both override selector sets from emitted CSS rather than
copying class names by hand:

```bash
pnpm nx build trinity
tr '}' '\n' < www/styles-*.css | grep 'text-destructive.*color:var(--destructive)'
tr '}' '\n' < www/styles-*.css | grep 'bg-destructive'
```

Mirror each emitted hover guard. A touchscreen must not regain a sticky hover
tint because an override omitted the source media query.

### Tailwind, layers, and class restrictions

Tailwind configuration is CSS-only in Theme Foundation's private adapter; there
is no tailwind.config file. Its order is theme, base, vendor, components,
utilities, then overrides.

| Layer      | Responsibility                                                    |
| ---------- | ----------------------------------------------------------------- |
| theme      | semantic values, generated utility variables, and named keyframes |
| base       | Preflight and native focus defaults                               |
| vendor     | the two registered static third-party stylesheets                 |
| components | authored component, shell, and rendered-content defaults          |
| utilities  | Tailwind, directive plugins, and Trinity utility classes          |
| overrides  | narrow accessibility and design-system invariants only            |

Theme Foundation resets stock colour, shadow, inset-shadow, drop-shadow, and
radius namespaces. Components use semantic colours, the closed elevation roles
raised, floating, and overlay, and the closed radius scale. Numbered stock
colours, default elevation steps, open-ended radii, arbitrary colour classes,
and arbitrary inner-appearance class inputs are not a public styling API.
Numeric spacing, default typography, and text-13 are temporary private
compatibility wiring, not Theme-authorable vocabulary.

The adapter's source globs include application and library TypeScript because
generated Helm recipes contain utility strings. Static CDK overlay and emoji
picker styles enter only through the named vendor seam. tw-animate-css is a
Tailwind directive plugin, so its output belongs to theme and utilities rather
than vendor.

Every authored component or inline stylesheet wraps its rules in the components
layer. There is no global important mode. The only approved important
declarations are the reduced-motion properties needed to override runtime
injected and inline animations; adding another is a contract change. The
[styling idiom guard](../../scripts/styling-idiom.spec.mjs) and cascade contract
reject an unlayered exception.

### Runtime vendor styles are an explicit exception

A library that injects styles at runtime cannot be converted to an ordinary
component stylesheet. The complete allowlist is
[runtime-vendor-styles.json](../../architecture/runtime-vendor-styles.json):

| Runtime owner        | Trinity seam                                    |
| -------------------- | ----------------------------------------------- |
| CodeMirror style-mod | token-only EditorView theme extension           |
| Angular CDK Overlay  | public overlay tier plus static vendor baseline |
| ng-icons             | trn-icon and audited generated Helm wrappers    |
| Brain Sonner         | trn-toaster and TrnToastService                 |

The architecture check pins those owners, package versions, injection markers,
and permitted import prefixes. An authored stylesheet does not qualify for this
list. Do not use a global selector or important declaration to beat a runtime
style; use the owner's supported token or extension seam.

### Runtime and production stylesheet constraints

Production style inlineCritical remains false. Electron serves production
assets through its custom protocol, where the deferred inline-critical
stylesheet handler does not activate. Changing it leaves token variables
inactive in the desktop renderer.

## 5. Change Appearance or add a Theme

Appearance has six independent axes carried by html: Mode, Theme, text size,
density, code size, and code-line presentation. The last controls the rendered
code-block line-number gutter: off, auto for blocks over five lines, or always.
The current resolved value is read-only and each axis has independent hydration
and persistence state. Mode and Theme select colour; the remaining axes size or
annotate presentation.
A partial hydration failure retains healthy axes, reports one recoverable
warning, and recovery writes defaults only for failed descriptors.

The document adapter carries the resolved value to html. Native chrome receives
Mode only. A system colour-scheme change changes resolved Mode only while the
committed choice is system. Its six carriers are `.dark`, `data-theme`, inline
`font-size`, `data-density`, `--trinity-code-scale`, and `data-code-lines`.
The default named Theme and fixed default sizing axes leave their optional
carriers absent, but default Mode is system: if the system resolves dark, the
adapter still applies the dark class. Rejected persistence never changes the
rendered value. Legacy preference keys are read-only migration metadata; exports
contain only current appearance entries. See the [document adapter](../../libs/application/appearance/src/lib/appearance-document.adapter.ts)
for the carriers it owns.

### Adding a Theme

1. Add sparse light and dark blocks in Theme Foundation variables, based on an
   existing named theme.
2. Scope light as root with the theme data attribute and not dark; scope dark
   as root with both the attribute and dark class.
3. Override only semantic colour and elevation roles listed by Theme catalogue
   authoring metadata. Do not name Helm or Tailwind tokens, component selectors,
   fonts, assets, or arbitrary CSS.
4. Register the identity, label, and data attribute in THEME_CATALOG. The
   default Trinity theme has no data-theme attribute.
5. Measure every changed and inherited role across every Mode and Theme.

```scss
:root[data-theme='example']:not(.dark) {
  /* sparse semantic light overrides */
}

:root[data-theme='example'].dark {
  /* sparse semantic dark overrides */
}
```

The not-dark selector is mandatory. A light attribute selector otherwise ties
the dark base selector and can win later in the stylesheet, leaking light
values into dark Mode. Theme authors do not set primary or
primary-foreground directly: the private adapter maps those vendor roles from
Trinity semantics.

The [token resolution guard](../../scripts/token-resolve.spec.mjs) rejects a
consumed Trinity token without a definition. The
[contrast matrix](../../scripts/contrast-matrix.spec.mjs) measures text roles
against every permitted surface, each syntax role against the rail, and the
solid pairs independently. A resolved token is not necessarily readable; both
checks are required.

### Syntax highlighting and rendered Markdown

Shiki syntax colours are the eight measured syntax roles and are consumed only
by [rendered markdown](../../apps/trinity/src/rendered-markdown.scss). The
fenced-code backdrop is the rail, not the chat canvas. Plain and punctuation
roles reference primary and muted text so they follow Mode automatically.

Shiki grammars live in the lazy Conversations feature and must stay private.
Measure the largest production chunk before and after adding a grammar; a new
grammar can dominate compressed payload. Do not export highlighting from a
public barrel, which would make the grammar bundle reachable from eager code.

Rendered message HTML has no Angular encapsulation attribute. Its shared child
rules therefore live in the global rendered-markdown stylesheet, scoped to the
message HTML container. Keep container whitespace and wrapping in the owning
row or dialog stylesheet. The generated fenced-language caption stays
bottom-right so it does not collide with the message hover toolbar.

The Matrix sanitizer is shared by incoming render and outgoing send. Its
[current allowlist](../../libs/util/matrix/src/lib/message-view.ts) permits the
Matrix tags plus data-mx-color, data-mx-bg-color, data-mx-emoticon, and
data-mx-spoiler attributes; it narrows classes to language-name, mx-spoiler,
and mx-emoticon, omits target,
and strips remote image sources. Only mxc, blob, and data image sources are
local. Do not add presentation behaviour in a sanitizer hook: attributes
written after sanitization bypass the allowlist.

Rendering also applies viewer-specific mention-pill normalisation after
sanitization, so cached rendered HTML is keyed by both the raw body and whether
the event addresses that viewer. Keep CSS rules content-oriented, but do not
assume every viewer receives identical normalized HTML.

The [outgoing Markdown adapter](../../libs/util/matrix/src/lib/message-content.ts)
has three deliberate rewrites: task-list inputs become ballot-box glyphs;
non-mxc images become visible links; and generated nested anchors are unwrapped.
Preserve these rewrites when changing Markdown rendering, because each avoids
content loss or unsafe markup on the wire.

### Preserve feature geometry and interaction contracts

A shared public component does not own the Rooms shell. Before changing a pane,
timeline, composer, or touch interaction, start at the feature source and keep
these current contracts intact:

- [rooms page styles](../../libs/feature/rooms/src/lib/rooms/rooms.page.scss)
  make the shell contain its panes; the timeline and each navigation surface
  own their own scrolling instead of growing document scroll. At wide widths a
  side panel remains in the row; at narrow widths it becomes a fixed drawer.
- [member-list virtualization](../../libs/feature/rooms/src/lib/member-list/member-list.component.ts)
  uses 34px headers and 44px member rows, matched by its stylesheet across pointer
  types and densities. Change measurements and spacer calculations together. The
  floating identity dock must leave the last Room and Space reachable, including
  keyboard-driven scrolling; [shell layout](../../e2e/browser/journeys/workspace/shell-layout.spec.mts)
  and [sidebar touch](../../e2e/browser/journeys/room-library/sidebar-touch.spec.mts)
  cover these geometry contracts.
- [pane handle](../../libs/feature/rooms/src/lib/rooms/pane-handle.component.ts)
  writes one CSS custom property during a drag, then commits once. Its keyboard
  separator supports arrows and Home/End. Do not replace this with signal
  updates per pointer frame: timeline row measurement and virtual-window
  prefix sums would re-run while the user drags.
- [drawer swipe](../../libs/feature/rooms/src/lib/rooms/drawer-swipe.directive.ts)
  reserves the native edge, abandons a horizontal gesture that becomes vertical
  scrolling, and writes only its transform property during the gesture. It is a
  drawer affordance, not a replacement for native history navigation.
- [shared message-list styles](../../libs/feature/rooms/src/lib/message-list/_message-list-shared.scss)
  give the timeline its scroll owner, keep code-block horizontal scrolling
  inside the block, and tie compact spacing and controls to density tokens while
  preserving the shared 44px coarse-pointer target floor. The
  [virtual list](../../libs/feature/rooms/src/lib/message-list/virtual-message-list/virtual-message-list.component.ts)
  intentionally renders a window and spacer geometry; preserve its scroll
  compensation and document the find, screen-reader, and cross-row-selection
  trade-off when changing it.
- In both timeline modes, an already bottom-pinned timeline stays exactly
  bottom-pinned when a composer or viewport change grows the conversation. A
  deliberate reading offset must keep its exact scroll position instead. The
  browser journey proves both cases on a
  long virtualized room in
  [timeline virtualization](../../e2e/browser/journeys/conversations/timeline-virtualization.spec.mts).
- [message composer](../../libs/feature/rooms/src/lib/message-composer/message-composer.component.ts)
  owns its single-row-growing input, staged-media lifecycle, and one-at-a-time
  send. It must not rewrite the buffer, accept a suggestion, or send Enter while
  an IME composition is active. The visible Send action remains available at
  every width because Enter can mean a newline or IME confirmation. Its
  [stylesheet](../../libs/feature/rooms/src/lib/message-composer/message-composer.component.scss)
  owns the feature-specific resting geometry, density-driven action sizing,
  semantic shapes, and motion tokens. The ordinary input and recording replacement
  keep equal resting heights, as covered by
  [composer formatting](../../e2e/browser/journeys/conversations/composer-formatting.spec.mts).
- The [composer insert menu](../../libs/feature/rooms/src/lib/message-composer/composer-insert-menu/composer-insert-menu.component.ts)
  uses an action sheet on iOS and Android, including installed and browser
  mobile hosts, and an anchored menu for desktop interaction. A changed room,
  thread, or capability invalidates the sheet's action snapshot. On dismissal
  it restores a viable trigger; an action that opens another surface transfers
  focus to that surface instead.

- [message-row styles](../../libs/feature/rooms/src/lib/message-row/message-row.component.scss)
  keep the toolbar from being clipped at conversation boundaries and preserve
  clearance on hybrid touch desktops without changing virtual-row height when
  actions appear. The authenticity shield reserves a column for message content
  only; receipts remain in flow, span the full message width, and follow writing
  direction. Preserve the [message-shield geometry checks](../../e2e/browser/journeys/trust/message-shield.spec.mts)
  when changing that layout.

These are feature contracts, not generic recipes. Use the linked sources and
their focused tests when a public component change can affect them.

## 6. Use overlays as lifecycle-bound presentation

The overlay entrypoint owns generic presentation, focus, placement, stack
management, and lifecycle. A dialog's placement is center, inline-end, bottom,
or fullscreen; side and alignment are anchored-overlay behaviour, not a dialog
visual treatment. `trnOverlaySurface` keeps treatment (`neutral|accent`),
ordinal size (`sm` through `2xl`), and structural layout (`dialog`, `sheet`,
`popover`, `panel`, `workspace`, or `fullscreen`) independent. It paints the
background, border, radius, and elevation for both document and CDK portal
content. Components own their interior layout and semantic content, not a
second backdrop, global z-index, or portal strategy.

An anchored overlay renders in the CDK container so it escapes clipping,
follows its anchor through scrolling and resizing, flips at the viewport edge,
and closes on an outside press without racing its anchor's click. It labels
nothing itself; the consumer supplies the semantic trigger and content.

Keep the root toaster mounted once in ApplicationRootComponent. A toast shown
while CDK makes the app root aria-hidden is mirrored through the body-level live
announcer; outside a modal, the toast library announces once. Do not bypass the
public toaster or create a second notification surface.

A product service opens a dialog and resolves a typed selection or value; its
caller performs the Matrix action. Keep a re-entrancy guard so a repeated
shortcut does not stack another dialog. Dialog result APIs are cold, finite
Observables: presentation starts on subscription and emits one result. Application
capabilities request a typed, cold Workspace application surface; the app
adapter alone chooses a lazy dialog or canonical route. A failed lazy load
leaves the current route intact, navigation invalidates pending presentation,
identical opens coalesce, and unrelated active surfaces do not stack.

## 7. Verify the right thing

Choose a test by the claim.

| Claim                                                        | Required evidence                                         |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| public input, recipe subset, or hostDirective                | strict template and component behaviour tests             |
| token definition or contrast                                 | token resolution and contrast matrix guards               |
| cascade, safe area, vendor import, or generated override     | relevant source guard plus a rendered browser proof       |
| keyboard, focus, overlay, or screen-reader state             | component test and browser or Storybook interaction proof |
| responsive layout, touch target, colour, or portal placement | Playwright with a real device profile or browser viewport |
| Capacitor, native chrome, or hardware Back                   | installed host evidence                                   |
| new public component or visible state                        | Storybook story covering the contract and variants        |

Storybook loads the same aggregate stylesheet and Theme catalogue as the app.
Use its complete category catalogues to inspect every Theme and Mode, compact
density, long labels and descriptions, invalid, read-only, loading, disabled,
focus, pointer, keyboard, and reduced-motion states. Axe must report neither
violations nor incomplete findings for the catalogued story surface. The one
established exception is a dropdown trigger's cross-popup `aria-controls`:
prove its live target in a browser before excluding that trigger from the scan.
Scan a CDK portal live and prove backdrop, initial focus, containment, and
restoration separately. Add an interaction test for an executable public
contract; stories do not replace browser evidence for CSS layout or host
behaviour. For Matrix sticker and emoji-pack behaviour, see
[image packs](image-packs.md).

For a UI change, run the declared project checks and the relevant source guards
first. The resolved Storybook targets are on components-storybook-host, while
the Theme Foundation target has test, lint, and typecheck; inspect them with
pnpm nx show project before choosing a command. The repository targets divide
proof as follows:

| Target                                        | What it proves                                                                   | Limit                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| pnpm nx run trinity-e2e-components:storybook  | static catalogues, Theme/Mode combinations, contrast, focus, and portal behavior | browser rendering only; no Matrix server                                                 |
| pnpm nx run trinity-e2e-components:styling    | compiled cascade, namespace closure, and destructive hover behavior              | does not prove a full conversation or host                                               |
| pnpm nx run trinity-e2e-components:scrollbars | real scrollbar and code-block rendering                                          | needs the disposable Synapse harness and must not overlap another Synapse-backed journey |

Then follow the full [validation policy](../contributing/testing.md#choose-validation-by-the-change):
a template change needs a build, jsdom does not prove layout, and a native claim
needs native evidence. Record only checks actually run and the unavailable host
limits.

## Quick contributor checklist

1. Select a public component or the owner of a genuinely new domain-neutral
   API; do not import Helm in a feature.
2. Use a bounded Trinity recipe and native semantics. Keep test hooks.
3. Put feature geometry in the feature and recipe chrome in the component.
4. Consume semantic Trinity tokens and check cascade and safe-area longhands.
5. For a theme, change semantic roles only and run resolution plus contrast.
6. For a generated Helm change, register and test every divergence.
7. For an overlay, preserve one owner, cold typed outcomes, focus, stack, and
   route-lifetime behaviour.
8. Add Storybook and the narrowest meaningful browser or host proof.
