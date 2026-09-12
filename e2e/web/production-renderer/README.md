# Production renderer contract

Use this suite for production Web renderer semantics, responsive geometry,
contrast, and selected accessibility behavior. For target ownership and resource
sequencing, read [E2E architecture](../../../apps/docs-developers/src/content/docs/testing/testing-strategy.md);
for choosing validation, read [Testing](../../../apps/docs-developers/src/content/docs/testing/component-and-browser-tests.md).

Run the registered target:

```bash
pnpm nx run trinity-e2e-web:production-renderer
```

The target owns one serialized, disposable-Synapse invocation, a production web
build (unless an explicitly verified prebuilt payload is selected), a bundle manifest,
browser processes, teardown, and ignored artifacts.
It requires Docker plus Chromium and WebKit. Do not run another Synapse-backed
suite alongside it.

## Understand the built artifact

By default, the runner builds `trinity:build:production`, writes a manifest for
`www/`, and serves that payload. `TRINITY_E2E_PREBUILT_WWW=1` is only for a
previously recorded `www/`: the runner verifies it against
`dist/web-bundle-manifest.json` and fails if either payload or manifest drifts.
CI downloads that payload from the renderer job and validates its full SHA,
production configuration, file manifest, manifest digest, and artifact coordinates
before enabling this mode. It is not a shortcut for an arbitrary local build.

The CI E2E job may build a development bundle during prerequisite preparation. The
production renderer step restores the verified production payload before starting this
suite; styling and browser steps run afterward against their intentional development
bundle.

The suite blocks the PWA service worker because service-worker behavior has its
own production-PWA contract. Blocking it keeps the disposable homeserver's
self-signed discovery traffic from becoming a synthetic worker failure while
this suite measures the renderer.

## Read the project matrix correctly

The Playwright configuration has nine projects in two groups:

| Group                    | Projects                                                                                                                                                      | What runs there                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application renderer     | `wide-dark-cosy`, `standard-amethyst-cosy`, `tablet-light-compact`, `compact-light-large`, `pixel-onyx-cosy`, `small-light-large`, and `webkit-compact-light` | [`application-renderer.spec.mts`](application-renderer.spec.mts) seeds a disposable room and checks its representative production surface contracts.                 |
| Theme and Mode artifacts | `appearance-desktop` and `appearance-mobile`                                                                                                                  | [`appearance-artifact.spec.mts`](appearance-artifact.spec.mts) checks the unauthenticated sign-in surface for each catalogued Theme with fixed light and dark modes. |

`application-renderer.spec.mts` deliberately skips the two `appearance-*`
projects. Do not describe one assertion as running in every project. The WebKit
project uses Playwright's WebKit engine; the other named viewports select their
configured browser and device profiles.

The application group gives representative cross-capability evidence, including
the login card, room shell, composer, overflow, readable headings, seeded
messages, appearance projection, accessible labels, emoji-picker focus return,
Settings, and encryption setup. The narrow profiles also check safe-area
placement and 44px Back and Send targets; `small-light-large` checks System Status
access and room-heading geometry, `standard-amethyst-cosy` changes Theme, and
`tablet-light-compact` checks keyboard focus under forced colours. The WebKit
project proves it is using WebKit.

The appearance group checks each catalogued Theme and fixed Mode at login for
semantic tokens, card geometry, overflow, and distinct token combinations. It
writes a review screenshot per combination only to ignored Playwright output.
Performance JSON is diagnostic evidence in the same output, not a
machine-independent timing budget. This remains representative renderer
evidence, not a pixel baseline or a complete cross-product of every interaction.

## Diagnose a failure

Start with the suite summary, JUnit result, blob report, and retained trace under
`dist/.playwright/trinity-e2e-web/<run-id>/`. Local runs also create an HTML
report there. The artifact root is ignored; attach useful proof directly to an
authorized pull request and never commit screenshots, traces, reports, or pixel
baselines.

A failure may come from the production build, manifest verification, Docker or
Synapse setup, a selected browser, or the renderer assertion. Preserve the
first failure and its artifact before retrying. A retry can identify flakiness;
it does not turn the original failure into a clean pass.

## State the limits

This suite proves a production Web payload in its owned browser and disposable
Matrix environment. It does not prove PWA service-worker behavior, a launched
Electron shell, an installed Android or iOS host, deployed push delivery, or
all product journeys. Use the matching registered target and host guide when
one of those boundaries changes.
