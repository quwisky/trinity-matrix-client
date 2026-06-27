---
name: e2e-conventions
description: How e2e tests are written and run in trinity-matrix-client (raw playwright, not @playwright/test)
metadata:
  type: project
---

This repo's e2e tests are **standalone Node ESM scripts** under `e2e/*.mjs`, run via
`node e2e/<name>.mjs` — using the raw **`playwright`** package (v1.61), **NOT
`@playwright/test`**. There is no `playwright.config.ts`, no test runner, no fixtures.

**Why:** matches the spike scripts (`crypto-spike.mjs`, `smoke-login.mjs`) the team
already had — each serves the built app and drives Chromium itself.

**How to apply when adding an e2e:**
- Build dev first: `pnpm nx build trinity --configuration=development` → outputs to `www/`.
- Serve `www/` with `serve(root, port)` from `e2e/support/serve.mjs` (static server +
  SPA fallback that returns `index.html` for extensionless routes).
- Launch `chromium` from `playwright`; drive with user-facing locators
  (`getByRole`/`getByText`/`getByTestId`); print `RESULT: PASS`/`FAIL` and
  `process.exit(0/1)`.
- Add a `package.json` script in the `nx build … && node e2e/<name>.mjs` style.
- Ionic `<ion-input label="X">` wraps a native input — fill via
  `page.locator('ion-input[label="X"] input')`, not `getByLabel` (Ionic's label
  association is inconsistent for `fill`).
- Ionic `AlertController` alerts render as `ion-alert` in the same DOM (not an iframe);
  password input = `ion-alert input[type="password"]`.
- Playwright browser binaries are NOT installed by default — run
  `npx playwright install chromium` once (cache at `~/Library/Caches/ms-playwright`).

See [[sas-verification-e2e]] for the device-verification flow specifics.
