---
title: Angular components
description: Build Trinity components with standalone imports, OnPush rendering, signal APIs, and clear ownership.
audience: developer
contentChannel: develop
canonicalTopic: development-angular-components
pageType: how-to
platforms: [web, desktop, android, ios]
---

Trinity uses Angular 22 in a zoneless application. Components render capability state and emit user intent; they do not become a second data-access layer.

## Follow the local component shape {#component-shape}

Keep component logic, template, stylesheet, and test in separate neighboring files. Use the established `trn` selector prefix, `ChangeDetectionStrategy.OnPush`, standalone imports, and the naming style already used by the owning library.

Prefer signal APIs for new inputs and outputs:

```ts
readonly room = input.required<RoomSummary>();
readonly opened = output<string>();
```

Use built-in template control flow. Give every `@for` loop a stable `track` expression. Self-close Trinity components that have no projected content.

## Keep state with its owner {#component-state}

Read public capability signals and derive presentation with `computed()`. A writable signal is appropriate for local interaction such as an open panel or a draft UI choice; it is not a copy of Matrix or Workspace state.

Subscribe to finite actions only where the UI owns the interaction lifetime, and clean them with `takeUntilDestroyed()`. Handle typed outcomes visibly. Avoid an `effect()` whose purpose is merely to copy one signal into another.

## Preserve accessibility contracts {#accessibility-contracts}

Start with native semantics, labels, keyboard behavior, focus restoration, and readable status text. Keep established `data-testid` hooks when a browser journey needs a stable non-semantic target. A click-only interaction or visual state without an accessible name is incomplete.

Read [public UI components](../public-ui-components/) before creating a reusable control and [state and reactivity](../../architecture/state-and-reactivity/) before binding capability state.
