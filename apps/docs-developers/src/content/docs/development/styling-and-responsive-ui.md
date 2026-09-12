---
title: Styling and responsive UI
description: Apply Trinity tokens and prove responsive, touch, focus, and overlay behavior in a real browser.
audience: developer
contentChannel: develop
canonicalTopic: development-styling-responsive-ui
pageType: how-to
platforms: [web, desktop, android, ios]
---

Style a component through semantic theme tokens and its own layout boundary. Responsive behavior is product behavior and needs browser evidence.

## Keep styles owned {#style-ownership}

Put component geometry in its stylesheet. Use global styles only for document behavior, resets, and explicitly registered vendor surfaces. Do not reach into another component's private DOM or copy vendor variables into product code.

Use semantic tokens from the theme foundation for surfaces, text, borders, focus, spacing, radius, and motion. Verify both light and dark appearance and preserve sufficient contrast and visible focus.

## Design narrow and wide states {#responsive-states}

Let the owning layout decide how one Workspace destination is presented at each width. Do not encode navigation state in a media query. Test content growth, text scaling, virtual keyboards, safe areas, scrolling, and touch targets where they affect the layout.

Keep established `data-testid` values stable when semantics cannot identify a complex interaction. Prefer roles, labels, and visible text for ordinary browser tests.

## Use the right evidence {#layout-evidence}

Stylelint and a build prove syntax and bundling. jsdom cannot prove breakpoints, focus rings, hit targets, overlays, scrolling, or native WebView behavior. Use the component browser suite for isolated surfaces, the application browser suite for product composition, and a launched host when the claim depends on Capacitor or Electron.

Store screenshots, traces, and temporary pixel comparisons under ignored output; never commit them. Read [component and browser tests](../../testing/component-and-browser-tests/) for the browser workflow.
