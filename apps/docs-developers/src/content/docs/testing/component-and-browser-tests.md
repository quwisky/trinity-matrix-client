---
title: Component and browser tests
description: Prove Angular interactions, responsive layouts, focus, and browser behavior at the right level.
audience: developer
contentChannel: develop
canonicalTopic: testing-component-browser
pageType: how-to
platforms: [web]
---

Use component tests for Angular behavior that jsdom can observe. Use Playwright in a real browser for layout, focus, scrolling, overlays, service workers, and complete product journeys.

## Run component coverage {#component-coverage}

```bash
pnpm nx test feature-auth
pnpm e2e:components
```

The focused library test is fast feedback for component state and rendered semantics. The registered component browser suites cover public UI, styling, scrollbars, and isolated responsive surfaces.

## Write resilient browser journeys {#resilient-journeys}

Use role, label, and visible text locators. Use an established `data-testid` only when semantics cannot identify the interaction. Scope locators to the relevant landmark or dialog and use Playwright's retrying assertions.

Do not wait with arbitrary sleeps. Wait for the URL, heading, control state, or exact server response that proves readiness. Do not wait for `networkidle` against a live Matrix client because `/sync` can remain open.

Use a complete mobile device profile for responsive and touch behavior; a desktop browser with `hasTouch` can still select a desktop application path. Playwright visibility alone does not prove an element with zero opacity is interactable.

## Choose the application suite {#application-suite}

```bash
pnpm e2e:browser
pnpm nx run trinity-e2e-web:production-pwa
```

The browser journey proves integrated UI against disposable Matrix services. The production-PWA target proves built routing, assets, and service-worker behavior without claiming a native host.

Keep traces and screenshots in ignored Playwright output. Read [styling and responsive UI](../../development/styling-and-responsive-ui/) and [diagnose failures](../diagnose-failures/).
