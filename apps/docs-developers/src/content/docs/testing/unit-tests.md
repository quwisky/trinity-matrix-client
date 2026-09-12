---
title: Unit tests
description: Run and write focused Vitest tests for Trinity libraries and repository invariants.
audience: developer
contentChannel: develop
canonicalTopic: testing-unit-tests
pageType: how-to
platforms: [web, desktop, android, ios]
---

Most application and library projects use Vitest through Nx. The `scripts` project runs Node-side repository guards, while Electron owns a separate Vitest installation and target.

## Run the owning project {#run-project}

```bash
pnpm nx test data-access-room-library
pnpm nx test data-access-room-library -- room-library.service
pnpm nx test data-access-room-library -- -t "restores the selected account"
```

Arguments after `--` are forwarded to Vitest for these targets. Inspect an unfamiliar project before assuming it uses the same runner or supports the same flags.

## Test behavior and lifetimes {#test-behavior}

Arrange the smallest public boundary, invoke behavior, and assert observable outcomes. For signals, read the public value. For cold actions, subscribe and verify completion, error, cancellation, and side effects. Use fake timers only for code whose contract is actually time-based, and restore them after each test.

Capability tests should cover account or conversation isolation, listener attachment and cleanup, source replacement, late-event rejection, expected unavailable states, and secret-safe errors where applicable.

Angular component tests import `render` from `@trinity/testing`; the wrapper sets signal inputs and output handlers before the first zoneless render. Use `TestBed.createComponent` only when a test requires synchronous control of animation frames or layout-bound scheduling.

## Add the missing type evidence {#type-evidence}

Vitest transpiles TypeScript; it does not type-check source or specs. Run the affected target separately:

```bash
pnpm nx run data-access-room-library:typecheck
pnpm nx run data-access-room-library:lint
```

Read [testing strategy](../testing-strategy/) before expanding scope and [diagnose failures](../diagnose-failures/) when the result is unexpected.
