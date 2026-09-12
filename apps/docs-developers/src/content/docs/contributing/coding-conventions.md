---
title: Coding conventions
description: Follow Trinity's Angular, import, state, style, testing, and compatibility rules.
audience: developer
contentChannel: develop
canonicalTopic: contributing-coding-conventions
pageType: reference
platforms: [web, desktop, android, ios]
---

Match the established owner before introducing a new pattern. Repository checks enforce many of these rules as contracts.

## Code and imports {#code-imports}

- Use `@trinity/*` public entrypoints across libraries and relative imports within one library.
- Keep features independent; shared product behavior belongs to data access or application orchestration.
- Keep `matrix-js-sdk` in approved data-access adapters and Matrix modeling utilities.
- Treat deprecations as errors; migrate to the supported API instead of suppressing the diagnostic.

## Angular and state {#angular-state}

- Keep component TypeScript, template, stylesheet, and spec separate.
- Use `trn` selectors, `OnPush`, current template control flow, signal inputs/outputs, and Signal Forms for new forms.
- Expose state as read-only signals and model one-shot actions as cold finite Observables.
- End component-owned subscriptions with lifecycle cleanup.

## UI and tests {#ui-tests}

- Consume reusable UI through `@trinity/components/*`; keep vendors behind the public tier.
- Use semantic tokens rather than literal colors and do not use `::ng-deep`.
- Preserve established `data-testid` hooks.
- Put unit specs beside their source and use real-browser evidence for layout and interaction claims.
- Keep screenshots, traces, prototypes, and pixel baselines in ignored output.

Run formatting, affected project checks, and architecture guards appropriate to the change. Read [Angular components](../../development/angular-components/) and [testing strategy](../../testing/testing-strategy/) for implementation detail.
