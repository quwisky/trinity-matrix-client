---
title: UI and theming
description: Work within Trinity's public component tier, design tokens, overlays, and responsive ownership.
audience: developer
contentChannel: develop
canonicalTopic: architecture-ui-theming
pageType: explanation
platforms: [web, desktop, android, ios]
---

Trinity's product UI consumes public components and semantic design tokens. The implementation layers beneath that surface can evolve without forcing feature code to depend on vendor APIs.

## Use the public UI tier {#public-ui-tier}

Feature and application code imports reusable UI from `@trinity/components/*`. The component libraries expose Trinity selectors, inputs, outputs, and accessibility behavior. Spartan Helm and Brain packages, generated Spartan source, and other vendors remain behind that tier.

If a control has product meaning, keep it with the owning feature. Move it into the component tier only when its API is domain-neutral and reusable. Components never import `matrix-js-sdk`.

### Button shapes {#button-shapes}

`trnBtn` takes a `shape` alongside its variant, size and presentation:

| Shape    | Use it for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`  | The default: a text button with its size's padding.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `icon`   | An icon-only button. It needs an accessible name and joins the shared icon-button interaction contract.                                                                                                                                                                                                                                                                                                                                                                                               |
| `row`    | A full-width list row whose label starts at the inline start and wraps instead of clipping; pair it with `ghost`. A solid secondary row, such as Block on the member card, fills with `--trinity-neutral-fill-surface`, because the shared secondary fill is about 1:1 on the overlay.                                                                                                                                                                                                                |
| `inline` | A link-style action inside a column of text, such as a Preview toggle under a description. It has no inline padding, so its label lines up with the text; pair it with `link` or `ghost`.                                                                                                                                                                                                                                                                                                             |
| `tile`   | A quick action in a centred row, such as Message on the member card: the projected icon sits in a 36px square carrying the variant's fill, with the label in small text below. Its `size` and `presentation` are ignored, and it has no attention roles, so keep it off attention surfaces. A secondary tile's square uses `--trinity-neutral-fill-surface`, which is only about 1.2:1 against the pane, not 3:1: the label and glyph identify the action, so the square only has to read as a shape. |

Feature templates choose a shape instead of adding padding, height or width classes to a `trnBtn`; the design-system contract rejects those.

### Tabs {#tabs}

The directives in `TrnTabsImports` from `@trinity/components/controls` follow the WAI-ARIA tabs pattern:

```html
<div trnTabs [(value)]="tab">
  <div trnTabList aria-label="Picker type">
    <button trnTab="gif">GIFs</button>
    <button trnTab="emoji">Emoji</button>
  </div>
  <div trnTabPanel="gif">…</div>
  <div trnTabPanel="emoji">…</div>
</div>
```

- Name the list in its context with `aria-label` or `aria-labelledby`; the component adds no name of its own.
- Arrow keys, Home and End move between tabs and wrap at the ends; right-to-left layouts flip the arrows. Activation is `automatic` by default, so moving also selects. Set `activation="manual"` when a panel moves focus into its own content as it appears, such as a search field: then Enter, Space or a click selects, and the tab stop follows focus until it leaves the list.
- Tab values become part of element ids, so use values without spaces.
- A `disabled` tab is skipped by the arrow keys and left out of the tab order. When nothing is selected, or the selected tab is disabled, the first enabled tab holds the tab stop.
- A panel whose tab is not in the list is plain content, with no `tabpanel` role, so a list can come and go without rebuilding the panels.
- Each panel is a tab stop. Set `[focusable]="false"` when the panel's first content is focusable itself.
- The default `appearance` is `segmented`: filled pills. Set `appearance="underline"` for a strip with a 1px `--trinity-border-overlay` divider and a 2px `--trinity-accent` bar under the selected tab, as on the member card. The selected tab's label also turns `--trinity-text-bright`, so the bar is not the only cue.
- A hidden panel stays in the DOM. Put its content behind `@if` when it should not run while hidden, as the expression picker does with its GIF search.
- The selected tab draws the `--trinity-state-selected-*` pill, hover the `--trinity-state-hover-*` roles, and a coarse pointer gets the 44px target. There is no attention-surface variant yet, so keep tabs off attention surfaces.

### Button focus ring {#button-focus-ring}

A solid primary `trnBtn` draws its focus ring `--trinity-focus-ring-offset` (2px) out from its edge, not flush against it. Its fill is too close to the ring's colour to tell the two apart (1.31-1.45:1 for the accent, 1:1 for the inverted attention action), so a flush ring reads as a thick border. The recipe swaps Helm's box-shadow ring for an outline: `ring-0`, a transparent border and a `--trinity-focus-ring-width` outline at that offset. The gap is transparent and shows whatever surface the button sits on, so on the surfaces measured (the canvas, a card, the rail and an attention surface) the ring keeps 3:1 or more against both of its sides. Under forced colours the overrides-layer `:focus-visible` rule in `global.scss` draws it in `Highlight`. Every other button keeps the shared ring. Feature code never adds `ring-` classes to a `trnBtn`; the ring belongs to the recipe.

## Style with semantic tokens {#semantic-tokens}

The root theme foundation defines color, spacing, shape, typography, motion, and surface tokens for light and dark appearance. Product styles consume those meanings instead of hard-coded color values or vendor custom properties.

Global CSS owns resets, app-wide document behavior, and explicitly registered vendor surfaces. Component geometry stays in the component stylesheet. Avoid selectors that reach into another component's private DOM.

## Choose a theme, surfaces, and density {#themes-and-density}

Appearance has three independent choices: mode (light, dark, or system), theme, and density. Themes only override governed color roles, so every theme must pass the contrast matrix in both modes.

| Theme    | Notes                                                                             |
| -------- | --------------------------------------------------------------------------------- |
| Graphite | The default (id `trinity`). Neutral greys, warm in light mode.                    |
| Classic  | Keeps the previous colours; the inset pane and rail tiles apply to every Theme.   |
| Midnight | Formerly Onyx. A stored `onyx` preference migrates to Midnight without a warning. |
| Amethyst | The purple theme.                                                                 |

The shell uses two surface roles. `--trinity-surface-app` is the app background behind the rail, sidebar, and user panel. `--trinity-surface-sidebar` is the channel sidebar tone: it follows the app background, and Classic overrides it with its previous sidebar colour. `--trinity-surface-pane` is the inset conversation pane. Consume them instead of a hard-coded color when a shell region needs one of those meanings.

`--trinity-message-surface` names the surface a rendered message body sits on. The container that draws message bodies sets it to its own background: the timeline and thread panes use `--trinity-surface-workspace`, the composer preview `--trinity-surface-raised` and edit history `--trinity-surface-overlay`. The rendered-markdown styles read it to colour a concealed spoiler's reason on its bar, and the sender-colour check measures sender colours against it. `--trinity-surface-canvas` is only the fallback when no container sets it, so a new place that renders message bodies on another surface must set the property itself. `scripts/contrast-matrix.spec.mjs` measures the spoiler reason on each of these surfaces.

A disabled control fades to `--trinity-disabled-opacity` (0.48), except a solid primary or danger `trnBtn`. Fading one takes its tinted fill and label toward the pane together, so a disabled primary or danger action fell to about 2:1. When it is `disabled` or `aria-disabled="true"` it therefore draws `--trinity-disabled-surface` with a `--trinity-disabled-foreground` label (5.13:1 or more) and a `--trinity-disabled-border` edge, at full opacity, also on an attention surface instead of the inverted action roles. Losing its tone is what marks the state. The border keeps the button's shape on the panes, where the neutral fill is only 1.02-1.64:1; on the accent the fill itself carries the shape (4.23:1 or more). A solid secondary button already rests on that neutral fill, so it keeps the fade, as outline, ghost and link buttons do: their icons and emoji ignore a text colour, and many of their resting labels are already muted. Under forced colours the system replaces these colours, so the rule paints the label and border `GrayText`. A tile button (`shape="tile"`) keeps its fill on its icon square, so a disabled primary or danger tile draws the disabled fill, border and foreground on that square, with a muted label, at full opacity; a disabled secondary tile fades. `TrnButton` publishes `data-trn-presentation`, `data-trn-variant` and `data-trn-shape` for these rules in `global.scss`; keep a visible reason next to an action you disable.

A component that paints the attention surface (`--trinity-state-attention-surface`, the accent) marks its root `data-trn-surface="attention"`: the accent `trn-banner`, the accent `trn-page-header` in either layout, and an accent `trnOverlaySurface` do. Set the attribute only on a component that owns the attention surface, never from feature code.

Inside that element, a solid primary `trnBtn` inverts to the `--trinity-state-attention-action-*` roles, because its normal accent fill would vanish on the accent ground. In an accent overlay this includes the overlay's own primary action, which is the button that needs it. The surface also switches every focusable inside it, including buttons of any presentation, fields, select triggers and links, to `--trinity-focus-ring-on-attention`, because they all sit on the accent and the default ring fails against it. A solid primary action keeps its [separated ring](#button-focus-ring) there, in that colour. The select trigger replaces Helm's half-transparent `--ring` halo with that ring, since the halo falls below 3:1 on the dark accents. Menus and tooltips opened from inside render in a portal outside the surface and keep their normal look.

Form controls are supported there too. A `trnInput` or `trnTextarea` field (including a file input's button label), a `trn-radio-group` in its `list` or `segmented` layout, a `trn-select` trigger, a `trn-checkbox`, a `trn-switch` and a primary or secondary outline `trnBtn` sit on the accent, so they switch to the `--trinity-state-attention-control-*` roles:

| Role                                              | Used for                                                                                                    | Floor against the attention surface |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `--trinity-state-attention-control-foreground`    | A typed value, a file button label, the select's value and chevron, radio and outline labels, the radio dot | 4.5:1                               |
| `--trinity-state-attention-control-placeholder`   | Field and select placeholders                                                                               | 4.5:1                               |
| `--trinity-state-attention-control-border`        | The resting border of a field, select, segmented track, radio, checkbox or outline button; a switch track   | 3:1                                 |
| `--trinity-state-attention-control-track-surface` | The segmented track fill, and the gap around its focus ring                                                 | Matches the surface                 |
| `--trinity-state-attention-control-danger`        | The border and ring of an invalid field, textarea or select, and an invalid checkbox or radio border        | 3:1                                 |

The segmented track keeps the surface colour instead of nesting a neutral fill. Its selected option inverts to the `--trinity-state-attention-action-*` roles like a solid action, and its on-attention ring sits on a gap in the track colour, so both clear 3:1 against the track. A checked checkbox and a checked switch track invert the same way, with the attention action foreground for the check mark and the thumb, and their rings sit on a gap in the surface colour. An outline button stays transparent, also while it holds an open menu, and hovers like a solid action. An option description follows its option's foreground, so it stays readable on the track, the hover fill and the selected fill. The accent leaves little room between 4.5:1 and the attention foreground in light modes, so the placeholder is only a little dimmer than a typed value there.

The neutral danger falls to 1.25-1.43:1 against the accent, so an invalid control takes `--trinity-state-attention-control-danger`, a pale red in light modes and a dark red in dark modes that keeps 3:1 (3.35-5.08:1). It is close to the resting border in lightness (1.18-1.35:1), so every invalid control on an attention surface (field, textarea, select, checkbox and list radio) also paints an opaque danger ring of 2px or more around its border, which marks the state without relying on hue, and `aria-invalid` carries it to assistive technology. Focus replaces that ring with the on-attention focus ring. A field, textarea, select or checkbox keeps its danger border while focused; a list radio's indicator takes the focus colour for its border too, as it does on neutral surfaces. A checked invalid checkbox keeps its danger border and ring. Write the error message in the surface's own foreground: the neutral `text-danger` falls below 1.5:1 on the accent.

These have no attention roles yet, so keep them off attention surfaces:

- danger buttons (`variant="danger"` in any presentation): they are not supported, because a red label that clears 4.5:1 on the light accents is nearly white (even `oklch(92% 0.04 25deg)` measures 4.08:1);
- primary link buttons, whose label is the accent and so disappears on it;
- secondary ghost, link and solid buttons;
- tile buttons (`shape="tile"`), whose primary square is the accent and whose neutral square has no attention role;
- the `boxed` layout of `trn-radio-group`: a list inside a `--trinity-border-overlay` box, with each option's description (such as why it is unavailable) at the end of its line, as in the member card's role picker;
- the hover fill of a primary ghost button, which is a neutral fill;
- `trnLabel` and `trn-field-label`, which keep `--trinity-text-bright`, `--trinity-text-muted` and `text-danger`.

`scripts/contrast-matrix.spec.mjs` measures these roles in every theme, and the Storybook foundation-states suite measures them in the accent page header and overlay.

The toolbar layout of the accent `trn-page-header` is a fixed 48px bar that does not wrap. Put form controls there only from Tailwind's `lg` breakpoint (1024px) up, and only as many as fit one row beside the title: the stories' rows of three to five controls need 936-1080px. Below that, use the page layout, which wraps its actions and grows to fit them. Controls that stack more than one line (a list radio group, segmented options with descriptions, a textarea) fit only the page layout, so the foundation-states suite measures them there and in the overlay, not in the toolbar layout.

All three effects (inverted solid buttons, the on-attention focus ring and the attention control colours) apply to every descendant, so neutral content placed directly inside an attention surface, such as a neutral card or banner, is unsupported: its buttons would invert, its fields would take light-on-accent colours, and its focus ring would be tuned against the wrong background.

Density has three options: cosy, compact, and spacious. Density changes spacing and sizing only and never sets colors; touch targets keep their 44px floor.

## Keep overlay behavior centralized {#overlay-behavior}

Dialogs, menus, tooltips, and other overlays use the Trinity overlay defaults and public component APIs. Preserve focus management, keyboard dismissal, stacking, and theme inheritance. Do not create a parallel overlay root for a single feature.

Open every modal surface through `TrnSurfaceService` from `@trinity/components/overlay`. It applies one rule: a bottom sheet on any phone or tablet and below `md`, a centred dialog otherwise, and an anchored menu for an action list opened from a button on a large screen. Use `kind: 'fullscreen'` or `'popover'` only for those explicit layouts; side panels keep their own non-modal components. `scripts/surface-service-usage.spec.mjs` keeps the dialog and action-sheet services it wraps inside the overlay library.

App lock's cover (`trn-app-lock-cover` in Application Runtime) is the one exception. It is a native `<dialog>` opened with `showModal()`, not a `TrnSurfaceService` surface, because it has to do three things a surface can't:

- paint in the first frame of a locked cold start, before any startup stage runs;
- sit in the browser's top layer, above every CDK overlay, the toaster and open dialogs (the overlay defaults turn CDK's `usePopover` off, so those compete on `z-index` and lose to the top layer);
- live outside the root's startup chain, so the boot spinner, startup recovery and routes all render beneath it.

The cover also moves its host out of `trn-root` into its own `<body>` child as it is created, before it first opens, because moving an open modal dialog takes it out of the top layer. An open CDK dialog marks every other `<body>` child `aria-hidden`, `trn-root` included. CDK skips children that have `aria-live`, so the host has `aria-live="off"`. That skip is undocumented CDK behaviour (the toaster's `LiveAnnouncer` relies on it too), so the cover's "stays exposed … as CDK skips [aria-live] body children" tests and the Electron App lock journeys pin it: a CDK upgrade that drops it fails them. The cover stays exposed to assistive technology over any CDK dialog, and CDK's record of what it hid is left alone. Keep `<trn-app-lock-cover />` a static child of the root template: inside a control-flow block, the block would put the host back into `trn-root`.

Don't copy this pattern for other surfaces. Anything that should appear above the lock, such as a future incoming call, renders inside the cover's reserved "above lock" region.

## Treat responsive layout as behavior {#responsive-layout}

Wide and narrow surfaces can present the same Workspace destination differently. The owning layout component decides what is visible; Workspace continues to own the semantic destination. Preserve `data-testid` hooks used by browser journeys and visible focus states used by keyboard navigation.

Angular components use `OnPush` change detection in the zoneless application. Signal updates drive rendering; browser evidence is still required for layout, focus, scrolling, and responsive behavior.

Read [dependency boundaries](../dependency-boundaries/) before importing UI and [state and reactivity](../state-and-reactivity/) before connecting a component to capability state.
