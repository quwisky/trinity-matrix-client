---
title: Validate a change
description: Select focused evidence, expand to affected gates, and report unavailable checks honestly.
audience: developer
contentChannel: develop
canonicalTopic: contributing-validate-change
pageType: how-to
platforms: [web, desktop, android, ios]
---

Choose checks from the behavior changed. Start focused for iteration, then run every separate contract the contribution affects.

## Inspect available targets {#inspect-targets}

```bash
pnpm nx show project <project-name> --json
pnpm nx affected -t lint test typecheck
```

Confirm the affected comparison base when the branch workflow is unusual. Tests, type checking, lint, stylelint, formatting, architecture, builds, browsers, protocol services, and hosts observe different claims.

## Add behavior-specific proof {#behavior-proof}

Run a focused unit test for policy, a component test for Angular interaction, a real browser for layout, disposable Synapse for Matrix behavior, and the actual host for Electron or native behavior. Run Synapse-backed suites sequentially because they share fixed ports.

For a product change, a typical wider set is:

```bash
pnpm test
pnpm nx run-many -t typecheck
pnpm lint
pnpm stylelint
pnpm format:check
pnpm build
pnpm architecture:check
```

Select from this set; do not claim every repository change always needs every command.

## Report actual outcomes {#report-outcomes}

Record commands, exit status, tested platforms, unavailable prerequisites, and diagnostic locations. A retry does not erase the first failure. A static check is not launched-host evidence.

Read [testing strategy](../../testing/testing-strategy/) and [diagnose failures](../../testing/diagnose-failures/).
