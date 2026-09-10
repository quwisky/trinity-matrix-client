# Node runner smoke checks

The `runner.chromium`, `runner.electron`, and `runner.android` suites are small additive
smokes powered by Node's built-in test runner. They exercise the same disposable account
and lifecycle ownership as the existing E2E targets while Playwright remains the owner of
the existing suites.

Run one locally with:

```bash
pnpm e2e:runner:chromium
pnpm e2e:runner:electron
pnpm e2e:runner:android
```

Install the pinned external tools into ignored `dist/runner-tools/` as needed.
Keep downloaded binaries outside `dist/.ci/`, which CI uploads with diagnostics:

```bash
node scripts/ci-runner-prerequisites.mjs chromium
node scripts/ci-runner-prerequisites.mjs electron
node scripts/ci-runner-prerequisites.mjs maestro
```

The installer verifies Chrome and ChromeDriver `153.0.8010.36`, Electron ChromeDriver
`150.0.7871.129`, and Maestro `2.10.0`. Locally, export the resulting paths explicitly:

```bash
export TRINITY_CHROME_BINARY="$PWD/dist/runner-tools/chrome-linux64/chrome"
export TRINITY_CHROMEDRIVER_BINARY="$PWD/dist/runner-tools/chromedriver-linux64/chromedriver"
export TRINITY_ELECTRON_CHROMEDRIVER_BINARY="$PWD/dist/runner-tools/electron-chromedriver/chromedriver-linux64/chromedriver"
export MAESTRO_CLI="$PWD/dist/runner-tools/maestro/maestro/bin/maestro"
```

In GitHub Actions, the installer writes the applicable paths to `GITHUB_ENV`. Android also
requires a disposable API 36 x86_64 emulator and SDK; Electron requires its pinned shell
dependencies and a display or Xvfb.

The Chromium smoke builds the development renderer. Electron and Android verify and reuse
the production renderer manifest; they do not build a second production renderer. All three
join disposable Synapse, and Android additionally owns the emulator resource. Android uses
Maestro for native input and an owned CDP connection to the visible app WebView for
diagnostics. Maestro first observes the login form before diagnostics attach; the
initial debug socket alone does not establish that the app WebView is ready. The
connection and ADB forward close on cancellation, including during startup.
Node tests run
serially because their test namespace is process-global. Each suite uses an isolated test
account and cleans up its host resources through the shared invocation lifecycle.

Reports and diagnostics currently use the coexistence artifact layout:

```text
dist/.playwright/trinity-e2e-browser/<run-id>/runner.chromium/
dist/.playwright/trinity-e2e-electron/<run-id>/runner.electron/
dist/.playwright/trinity-e2e-android/<run-id>/runner.android/
```

These smokes supplement the existing Playwright coverage. They do not claim that the full
E2E migration is complete or replace the reliability and diagnostic guarantees of the
canonical suites.
