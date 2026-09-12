---
title: Testing strategy
description: Choose the smallest Trinity check that directly observes the claim changed.
audience: developer
contentChannel: develop
canonicalTopic: testing-strategy
pageType: explanation
platforms: [web, desktop, android, ios]
---

Validation is evidence about a specific claim. Choose the smallest check that can fail for the behavior you changed, then add separate checks for types, architecture, styling, builds, and hosts when those contracts are affected.

## Match claims to checks {#claim-check-map}

| Claim                                        | Direct evidence                                  |
| -------------------------------------------- | ------------------------------------------------ |
| Pure transformation or service policy        | Focused Vitest unit test                         |
| Angular template interaction                 | Component test through the shared render helper  |
| TypeScript or template type safety           | Affected project's `typecheck` and Angular build |
| Import or ownership boundary                 | Architecture and source-shape guards             |
| CSS syntax                                   | Stylelint                                        |
| Responsive layout, focus, scrolling, overlay | Real-browser component or application journey    |
| Matrix protocol behavior                     | Disposable-Synapse E2E journey                   |
| Electron, Android, or iOS behavior           | Launched target host on a suitable machine       |

A passing unit test does not prove type safety or layout. A browser emulation does not prove a Capacitor plugin or installed WebView. A static host check does not prove launch behavior.

## Iterate, then widen {#iterate-widen}

Run the focused target while changing code. Before review, run the applicable project test, typecheck, lint, build, architecture, style, and user-journey checks. Use `pnpm nx show project <name> --json` to inspect targets rather than guessing.

If a test is intended to prevent a regression, temporarily reverse the fix or mutate the relevant behavior and confirm the test fails for the expected reason.

## Preserve honest evidence {#honest-evidence}

Record the exact command, checkout state, exit status, and unavailable prerequisites. A pass on retry is evidence of an initial failure, not a clean pass. Never replace an unavailable native environment with a claim that static checks covered it.

Continue with [unit tests](../unit-tests/), [component and browser tests](../component-and-browser-tests/), or [Matrix E2E tests](../matrix-e2e-tests/).
