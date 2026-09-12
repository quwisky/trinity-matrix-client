# Preview and verify Trinity components

This project hosts one Storybook for Trinity's five public component categories. Use it to
select a public control, inspect its states and verify an appearance change before exercising
the feature that uses it. Follow [UI contribution guidance](../../../apps/docs-developers/src/content/docs/architecture/ui-and-theming.md)
for component APIs, tokens, responsive behavior and the vendor boundary.

## Open the catalog

From the repository root, install the pinned dependencies using
[contributor setup](../../../apps/docs-developers/src/content/docs/start/clone-and-install.md), then run:

```bash
pnpm storybook
```

The equivalent resolved Nx task is `pnpm nx storybook components-storybook-host`. Use the
local URL printed by Storybook. Theme, light/dark Mode and Cosy/Compact density are toolbar
controls; change them while reviewing each story's examples, control states and empty/error
states. The Theme and Mode choices come from Theme Foundation's catalog.

The toolbar previews resolved light/dark Mode. It does not run the application's system-Mode
preference, persistence or native-chrome lifetime, and it does not expose all six Appearance
axes. Use the application/host journeys for those contracts. A story-specific text-size example
is not a global toolbar setting.

The accessibility addon is configured with `test: 'error'`. Inspect its results and keyboard
behavior; the addon alone does not establish color contrast, usable focus order, screen-reader
behavior or application accessibility.

## Add or update a story

Keep a `*.stories.ts` file beside the public component it documents. The
[story configuration](.storybook/main.ts) includes:

- the five `libs/components/*` categories: Foundations, Controls, Generic Content,
  Navigation/Layout and Overlay;
- two explicitly retained Conversations presentation surfaces, `media-bubble` and
  `message-toolbar`, under `libs/feature/rooms`.

Vendored Helm code and stateful feature pages are excluded. A missing catalog entry does not
permit a feature to bypass the public UI tier. Add the appropriate public wrapper and story,
using its real selectors, exported inputs and supported variants. Prefer an existing sibling
story as the composition example and keep Matrix/Account behavior in the feature's own tests.

The host contains configuration and an empty source entrypoint; it is not another component
library. Nx infers Storybook tasks through `@nx/storybook/plugin`. Compodoc is disabled in the
Angular/Vite framework options; component source docblocks remain the API reference.

## Use the application's cascade and carriers

[preview-head.html](.storybook/preview-head.html) declares the layer order before bundled styles:
`theme, base, vendor, components, utilities, overrides`. The
[global styles](.storybook/global-styles.scss) load Theme Foundation, application globals and
CDK positioning in the vendor layer, then paint the canvas body with semantic surface/text tokens.
Keep this composition aligned with the application rather than styling the preview as a separate
visual product.

The [preview decorator](.storybook/preview.ts) applies resolved Mode through `.dark`, Theme
through `data-theme` and Compact density through `data-density`. Default Theme and Cosy density
remove their attributes. It changes token carriers; the canvas stylesheet paints their values.
Do not add an unlayered override to make a story pass when the same component would fail in the
application cascade.

## Build and run browser checks

```bash
pnpm storybook:build
pnpm nx run trinity-e2e-components:storybook
```

The static build target is `components-storybook-host:build-storybook`. Its output is
`dist/storybook/components-storybook-host` at the repository root. Keep artifacts there:
placing generated output under `libs/` makes source, style and project-discovery guards scan it.

The component browser target builds the catalog and owns a temporary static server. It needs
Playwright browsers, but no application server or disposable Synapse. Its
[Playwright configuration](../../../e2e/components/playwright.storybook.config.mts) runs desktop
Chromium, a Pixel 5 Chromium profile for mobile specs, and desktop WebKit for explicitly named
WebKit specs. Those are browser checks, not Android or iOS native execution.

If a cache hit reports success but the output directory lacks `index.html` or `iframe.html`,
the browser will receive “Not found” rather than a catalog. Rebuild and run with Nx caching
disabled so the nested catalog build also executes:

```bash
NX_SKIP_NX_CACHE=true pnpm nx run trinity-e2e-components:storybook
```

Record the initial failure and the fresh-build result separately. Do not treat an artifact-free
cache hit as rendering evidence or add retries to hide it.

For a focused full-canvas Theme × Mode check:

```bash
pnpm nx run trinity-e2e-components:storybook -- theme-surface.spec.mts
```

The catalog suites cover token-driven surfaces, public recipe states, focus and interaction,
portal placement, contrast and accessibility assertions. Their exact cases live under
[`e2e/components/storybook`](../../../e2e/components/storybook). A passing static build proves
compilation; a passing focused file proves only its assertions. Neither proves authenticated
Room flows or platform behavior outside the canvas.

For actual application CSS, run `trinity-e2e-components:styling`. Application scrollbar checks
use `trinity-e2e-components:scrollbars` and require the disposable Synapse resource. Follow
[validation selection](../../../apps/docs-developers/src/content/docs/contributing/validate-a-change.md) and the
[E2E task guide](../../../e2e/README.md) for filters, prerequisites, output and cleanup ownership.
Keep screenshots/traces under ignored test output and use them as review evidence rather than
committing them to this host.
