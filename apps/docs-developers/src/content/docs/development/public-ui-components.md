---
title: Public UI components
description: Add reusable Trinity UI through the components tier without exposing Spartan or vendor internals.
audience: developer
contentChannel: develop
canonicalTopic: development-public-ui-components
pageType: how-to
platforms: [web, desktop, android, ios]
---

The public UI boundary is `@trinity/components/*`. Feature code should be able to use a Trinity control without knowing which headless primitive or styled vendor implementation sits beneath it.

## Decide whether a component is public {#public-decision}

A public component is domain-neutral, reusable, and owns a coherent interaction or layout contract. A room-specific toolbar, verification step, or settings section stays with its feature even if it contains reusable controls.

Search the existing component entrypoints and Storybook before adding another abstraction. Extend an existing API when the new behavior preserves its semantics.

## Compose the implementation {#compose-implementation}

Expose Trinity selectors, signal inputs and outputs, accessible states, and semantic token styling. Keep Spartan Brain/Helm and other vendor imports inside the implementation tier. Do not edit generator-owned Spartan files by hand unless the generator workflow owns the change.

Preserve focus, keyboard behavior, labels, described-by relationships, disabled semantics, overlay positioning, and dark/light theming. A wrapper that changes a control's semantics must add tests for the new public contract.

## Publish one entrypoint {#publish-entrypoint}

Export the supported API from the component library's `src/index.ts`. Consumers use its `@trinity/components/*` alias, never a source-path deep import. Keep implementation helpers private until they have a supported cross-library contract.

Use unit tests for API and state behavior, Storybook for isolated states, and browser tests for layout, focus, overlays, and responsive interaction. Read [UI and theming](../../architecture/ui-and-theming/) and [styling and responsive UI](../styling-and-responsive-ui/).
