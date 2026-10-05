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

## Use tokens, not literals {#token-literals}

Stylelint rejects literal values for `font-size`, padding, margin, gap, border radius and `z-index`, and hex colours, everywhere except `libs/theme-foundation`. A literal is a number with a common length unit (px, rem, em, vh and similar) or a percentage, or any integer `z-index`. `0`, keywords, `var()`, `env()` and `calc()` with unitless factors are allowed; a `var(--x, 4px)` fallback is a literal too.

Existing literals are recorded per file in `stylelint-suppressions.json`. That list may only shrink: `pnpm stylelint` fails a file that gains one, and `scripts/stylelint-suppressions.spec.mjs` fails when the list no longer matches the stylesheets exactly or grows against `main`. Counts are per declaration, not per literal: a declaration with several literals is one entry, so replacing only some of its literals does not shrink the list. After replacing every literal in a declaration with a token, regenerate the list and commit the smaller file:

```bash
pnpm stylelint --suppress=declaration-property-value-disallowed-list --suppress=color-no-hex
```

Never regenerate to make a new literal pass; use the matching `--trinity-*` token from `libs/theme-foundation` instead.

## Design narrow and wide states {#responsive-states}

Let the owning layout decide how one Workspace destination is presented at each width. Do not encode navigation state in a media query. Test content growth, text scaling, virtual keyboards, safe areas, scrolling, and touch targets where they affect the layout.

Keep established `data-testid` values stable when semantics cannot identify a complex interaction. Prefer roles, labels, and visible text for ordinary browser tests.

## Use the right evidence {#layout-evidence}

Stylelint and a build prove syntax and bundling. jsdom cannot prove breakpoints, focus rings, hit targets, overlays, scrolling, or native WebView behavior. Use the component browser suite for isolated surfaces, the application browser suite for product composition, and a launched host when the claim depends on Capacitor or Electron.

Store screenshots, traces, and temporary pixel comparisons under ignored output; never commit them. Read [component and browser tests](../../testing/component-and-browser-tests/) for the browser workflow.
