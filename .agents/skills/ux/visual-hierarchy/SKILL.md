---
name: visual-hierarchy
description: "Trinity visual-hierarchy work: readable content order, typography, density, spacing, emphasis, or responsive layout. Use when a screen's information order or scanability changes within existing UI and Appearance contracts."
allowed-tools: Read, Grep, Glob, Write, Edit
---

# Trinity visual hierarchy

Use the [UI and theming guide](../../../../docs/architecture/ui-and-theming.md)
and the owning feature source before changing a screen's information order,
reading surface, or responsive geometry.

## Make the current task readable

1. Put the task, current state, primary action, and destructive consequence in
   a readable order. Group related controls under a meaningful heading and
   disclose detail where it becomes relevant to the action.
2. Use the existing type, spacing, density, semantic colour, shape, and
   elevation roles. Appearance owns text size and density; do not add a fixed
   grid, percentage rule, or separate typography scale from a generic recipe.
3. Preserve the owner of scrolling and reading position. A feature's pane or
   timeline geometry is not a public component styling shortcut.
4. Keep emphasis semantic: a danger state uses the existing readable danger
   role, focus remains visible, and disabled or loading presentation does not
   hide the action's meaning.

## Verify the rendered result

Use a real browser for line wrapping, reading order, responsive placement,
scrolling, contrast, and coarse-pointer geometry. Check the relevant Theme,
Mode, text size, density, long-label, keyboard, and reduced-motion states.
For a shared public component, add its Storybook and behavior proof; for a
feature surface, use the owning journey and preserve its established contracts.
