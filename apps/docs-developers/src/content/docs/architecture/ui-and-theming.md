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

## Keep overlay behavior centralized {#overlay-behavior}

Dialogs, menus, tooltips, and other overlays use the Trinity overlay defaults and public component APIs. Preserve focus management, keyboard dismissal, stacking, and theme inheritance. Do not create a parallel overlay root for a single feature.

## Treat responsive layout as behavior {#responsive-layout}

Wide and narrow surfaces can present the same Workspace destination differently. The owning layout component decides what is visible; Workspace continues to own the semantic destination. Preserve `data-testid` hooks used by browser journeys and visible focus states used by keyboard navigation.

Angular components use `OnPush` change detection in the zoneless application. Signal updates drive rendering; browser evidence is still required for layout, focus, scrolling, and responsive behavior.

Read [dependency boundaries](../dependency-boundaries/) before importing UI and [state and reactivity](../state-and-reactivity/) before connecting a component to capability state.
