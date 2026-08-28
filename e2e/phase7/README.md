# Shipped interface evidence

This suite is the Phase 7 visual and semantic gate for Trinity's real built application. It is
separate from both the immutable Phase 0 archive under `e2e/design-baselines/archive/` and the
non-shipping static prototypes under `e2e/design-prototypes/`.

Run it with:

```bash
pnpm e2e:design:shipped
pnpm exec nx run trinity-e2e:phase7-visual-e2e -- --update-snapshots
```

Only Playwright's managed Linux Chromium may update the committed PNGs. The suite uses fixed
accounts, room copy and timestamps; loads the locked Nunito Sans files from Storybook; waits for
fonts; disables animations, carets and incidental tooltips; and records per-project performance
evidence in the Playwright report.

The suite blocks the PWA service worker. Chromium otherwise routes the disposable homeserver's
self-signed TLS discovery through the worker and synthesizes a 504, which tests worker/network
behavior instead of the shipped UI this suite owns. The same production JavaScript, CSS and assets
are still served and hash-verified before they are copied into Electron and Android.

## Pairwise matrix

| Project                | Viewport/device | Appearance                | Pixel-gated surfaces |
| ---------------------- | --------------- | ------------------------- | -------------------- |
| wide-dark-cosy         | 1440x900        | dark Trinity, Cosy        | room                 |
| standard-amethyst-cosy | 1280x720        | dark Amethyst, Cosy       | room, emoji picker   |
| tablet-light-compact   | 1024x768        | light Trinity, Compact    | room                 |
| compact-light-large    | 900x700         | light, Compact, 125% text | settings             |
| pixel-onyx-cosy        | full Pixel 5    | dark Onyx, Cosy           | room, emoji picker   |
| small-light-large      | full 320x568    | light, Compact, 125% text | login, crypto        |
| webkit-compact-light   | 900x700 WebKit  | light Trinity, Compact    | semantic checks only |

Every project still checks horizontal overflow, surface bounds, representative rendered contrast,
reduced motion, accessible control names and picker focus restoration. The 1024px project also
checks forced-colour activation and keyboard focus. Pixel screenshots are intentionally limited to
stable representative compositions; semantics and geometry cover the rest of the matrix without a
brittle Cartesian snapshot explosion.

The attached performance JSON is diagnostic evidence, not a machine-independent timing budget.
Production Angular budgets remain the hard bundle-size gate. A Phase 7 timing regression must be
reproduced against the same machine and base revision before it becomes a blocking finding.
