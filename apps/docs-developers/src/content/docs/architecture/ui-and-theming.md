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

A component that paints the attention surface (`--trinity-state-attention-surface`, the accent) marks its root `data-trn-surface="attention"`: the accent `trn-banner`, the accent `trn-page-header` in either layout, and an accent `trnOverlaySurface` do. Set the attribute only on a component that owns the attention surface, never from feature code.

Inside that element, a solid primary `trnBtn` inverts to the `--trinity-state-attention-action-*` roles, because its normal accent fill would vanish on the accent ground. In an accent overlay this includes the overlay's own primary action, which is the button that needs it. The surface also switches every focusable inside it, including buttons of any presentation, fields, select triggers and links, to `--trinity-focus-ring-on-attention`, because they all sit on the accent and the default ring fails against it. The select trigger replaces Helm's half-transparent `--ring` halo with that ring, since the halo falls below 3:1 on the dark accents. Menus and tooltips opened from inside render in a portal outside the surface and keep their normal look.

Form controls are supported there too. A `trnInput` or `trnTextarea` field, a segmented `trn-radio-group` and a `trn-select` trigger sit on the accent, so they switch to the `--trinity-state-attention-control-*` roles:

| Role                                              | Used for                                                      | Floor against the attention surface |
| ------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------- |
| `--trinity-state-attention-control-foreground`    | A typed value, the select's value and chevron, segment labels | 4.5:1                               |
| `--trinity-state-attention-control-placeholder`   | Field and select placeholders                                 | 4.5:1                               |
| `--trinity-state-attention-control-border`        | The resting border of a field, select or segmented track      | 3:1                                 |
| `--trinity-state-attention-control-track-surface` | The segmented track fill, and the gap around its focus ring   | Matches the surface                 |

The segmented track keeps the surface colour instead of nesting a neutral fill. Its selected option inverts to the `--trinity-state-attention-action-*` roles like a solid action, and its on-attention ring sits on a gap in the track colour, so both clear 3:1 against the track. The accent leaves little room between 4.5:1 and the attention foreground in light modes, so the placeholder is only a little dimmer than a typed value there. Checkboxes, switches, list radio groups, segmented option descriptions, the file input's button label, outline buttons and invalid states have no attention roles yet ([#1244](https://github.com/quwisky/trinity-matrix-client/issues/1244)); keep them off attention surfaces. An invalid field there would swap its danger border for the attention border while keeping the danger shadow. `scripts/contrast-matrix.spec.mjs` measures these roles in every theme, and the Storybook foundation-states suite measures them in the accent page header and overlay.

All three effects (inverted solid buttons, the on-attention focus ring and the attention control colours) apply to every descendant, so neutral content placed directly inside an attention surface, such as a neutral card or banner, is unsupported: its buttons would invert, its fields would take light-on-accent colours, and its focus ring would be tuned against the wrong background.

Density has three options: cosy, compact, and spacious. Density changes spacing and sizing only and never sets colors; touch targets keep their 44px floor.

## Keep overlay behavior centralized {#overlay-behavior}

Dialogs, menus, tooltips, and other overlays use the Trinity overlay defaults and public component APIs. Preserve focus management, keyboard dismissal, stacking, and theme inheritance. Do not create a parallel overlay root for a single feature.

Open every modal surface through `TrnSurfaceService` from `@trinity/components/overlay`. It applies one rule: a bottom sheet on any phone or tablet and below `md`, a centred dialog otherwise, and an anchored menu for an action list opened from a button on a large screen. Use `kind: 'fullscreen'` or `'popover'` only for those explicit layouts; side panels keep their own non-modal components. `scripts/surface-service-usage.spec.mjs` keeps the dialog and action-sheet services it wraps inside the overlay library.

## Treat responsive layout as behavior {#responsive-layout}

Wide and narrow surfaces can present the same Workspace destination differently. The owning layout component decides what is visible; Workspace continues to own the semantic destination. Preserve `data-testid` hooks used by browser journeys and visible focus states used by keyboard navigation.

Angular components use `OnPush` change detection in the zoneless application. Signal updates drive rendering; browser evidence is still required for layout, focus, scrolling, and responsive behavior.

Read [dependency boundaries](../dependency-boundaries/) before importing UI and [state and reactivity](../state-and-reactivity/) before connecting a component to capability state.
