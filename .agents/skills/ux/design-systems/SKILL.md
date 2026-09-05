---
name: design-systems
description: 'Trinity design-system work: public UI components, Theme Foundation tokens, Appearance, themes, or component styling. Use when changing a shared visual contract rather than a feature-only layout.'
allowed-tools: Read, Grep, Glob, Write, Edit
---

# Trinity design system

Start with the [UI and theming guide](../../../../docs/architecture/ui-and-theming.md).
It is the canonical source for Theme Foundation, public component ownership,
token vocabulary, cascade rules, and validation.

## Choose the owner

1. Put reusable, domain-neutral presentation in the public
   `@trinity/components/*` tier. Features consume that tier and do not import
   Helm or a UI vendor directly.
2. Keep product-specific layout, state, and Matrix behavior in its feature or
   capability owner. A shared component does not acquire a Rooms, Account, or
   preference lifetime.
3. Use the existing semantic Trinity tokens and public recipe inputs. For
   readable destructive text or icons, use `text-danger` or
   `var(--trinity-danger)`, never Helm `text-destructive` as foreground ink.
4. Route a new shared component through its public API, Storybook story, and
   source-backed tests. Do not introduce a second token system or React/shadcn
   conventions.

## Change Appearance or a Theme

Appearance has six independent axes: Mode, Theme, text size, density, code
size, and code-line presentation. Theme and Mode select colour; the other axes
size or annotate presentation. Follow the Theme catalogue and document adapter
in the UI guide; do not add a token, carrier, or persistence rule from a generic
example.

A named Theme overrides sparse semantic colour and elevation roles. Keep its
light and dark selectors, inherited roles, contrast matrix, and generated
invariant checks aligned. Use the guide's [theme change procedure](../../../../docs/architecture/ui-and-theming.md#5-change-appearance-or-add-a-theme)
and [verification matrix](../../../../docs/architecture/ui-and-theming.md#7-verify-the-right-thing).
