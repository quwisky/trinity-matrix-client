---
name: interaction-design
description: 'Trinity interaction work: responsive behavior, overlays, focus, touch targets, motion, loading feedback, or reduced-motion behavior. Use when an interaction contract needs source-backed design and browser proof.'
allowed-tools: Read, Grep, Glob, Write, Edit
---

# Trinity interaction design

Use the [UI and theming guide](../../../../docs/architecture/ui-and-theming.md)
for the current component, overlay, responsive, and validation contracts.

## Preserve the interaction model

- Ask whether the decision is about OS or input. Mobile OS selects the
  interaction model; `(pointer: coarse)` selects target size. They are not
  interchangeable. Shared controls keep the 44px coarse-pointer target floor.
- Keep overlays lifecycle-bound through the public overlay tier. Preserve focus,
  keyboard, dismissal, and return-focus behavior rather than adding a feature
  backdrop or global z-index.
- Use the existing motion tokens and component behavior. Every new or changed
  motion path needs its relevant reduced-motion behavior; do not impose generic
  duration tables or global animation resets.
- Keep loading and mutation feedback in the capability that owns the action.
  Do not create optimistic state that competes with Matrix or projection state.

When a change reaches Rooms panes, timeline, composer, or insertion behavior,
follow the source links in the UI guide's
[feature geometry and interaction contracts](../../../../docs/architecture/ui-and-theming.md#preserve-feature-geometry-and-interaction-contracts).

## Prove the claim

Use component tests for a public contract and a real browser for responsive
layout, focus, overlay placement, motion, or touch behavior. A unit test cannot
prove CSS geometry; a touch-emulated desktop is not a mobile device profile.
Use installed-host evidence for native behavior and report any unavailable host.
