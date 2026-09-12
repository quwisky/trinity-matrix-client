---
title: Diagnose failures
description: Preserve evidence, isolate the failing layer, and distinguish regressions from environment problems.
audience: developer
contentChannel: develop
canonicalTopic: testing-diagnose-failures
pageType: how-to
platforms: [web, desktop, android, ios]
---

Treat the first failure as evidence. Repeating a command without understanding its output can erase the only useful trace or hide a race behind a pass.

## Capture the exact failure {#capture-failure}

Record the command, revision or working-tree state, exit code, first relevant error, and artifact path. For Nx configuration surprises, inspect the resolved project and clear stale daemon state only when the evidence points there:

```bash
pnpm nx show project <project-name> --json
pnpm nx reset
```

Read a failing source-shape guard before changing it. Its assertion often protects a boundary that a local compile does not observe.

## Isolate one layer {#isolate-layer}

Reduce a unit failure by file or test title. For browser failures, inspect the retained trace, DOM snapshot, console, and network timeline before choosing a narrower locator or readiness condition. Replace arbitrary waits with a retrying assertion on the state the user needs.

For Synapse, determine whether the failure belongs to Docker startup, server readiness, fixture ownership, Matrix behavior, or the browser journey. For a native host, separate build/toolchain failure, launch failure, bridge negotiation, and product behavior.

## Reproduce without laundering the result {#reproduce-result}

```bash
pnpm nx test <project-name> -- -t "failing behavior"
pnpm nx run trinity-e2e-browser:e2e -- --grep "failing journey"
```

A pass on retry does not erase the initial failure. Check for leaked ports, shared test data, time dependence, missing readiness, and cross-test state. Confirm a proposed test fix still fails when the product regression is reintroduced.

Keep diagnostics value-safe and keep traces, screenshots, logs, and temporary reproductions under ignored output. Report unavailable prerequisites plainly.

Return to [testing strategy](../testing-strategy/) to select the final evidence set.
