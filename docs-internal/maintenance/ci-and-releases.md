# CI and releases

This private guide is for maintainers diagnosing automation and preparing a desktop
release. It describes the workflows that are committed today. It does not
authorize a release, a tag, a workflow dispatch, a settings change, or the use
of a signing credential; those are separate external actions.

For checkout, local commands, branch rules, and validation selection, use the
public developer guide.

## Know what ran

| Workflow                                                             | Starts when                                                                | What it provides                                                                                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ci.yml`](../../.github/workflows/ci.yml)                           | A pull request, selected pushes, or its weekly schedule                    | Branch checks and browser, desktop, and Android evidence                                                                                                        |
| [`docs-pages.yml`](../../.github/workflows/docs-pages.yml)           | A `main` push, a published stable release, or a manual dispatch            | Validated user and developer sites deployed to GitHub Pages                                                                                                     |
| [`release.yml`](../../.github/workflows/release.yml)                 | A push to `main` or `release/**`, or a manual dispatch with a tag input    | release-please release PRs and tags, then tag verification, desktop packages, a draft GitHub release, its publication, and the back-merge PR after a stable tag |
| [`homebrew.yml`](../../.github/workflows/homebrew.yml)               | A release is published, or a manual dispatch with a tag input              | Signed macOS app verified, cask generated and pushed to `quwisky/homebrew-trinity`                                                                              |
| [`e2e-ios-nightly.yml`](../../.github/workflows/e2e-ios-nightly.yml) | Daily at 04:13 UTC or a manual dispatch (`specs` input narrows the run)    | The installed iOS app on the Simulator against native Synapse, with scrubbed diagnostics                                                                        |
| [`renovate.yml`](../../.github/workflows/renovate.yml)               | Daily at 00:00 UTC or a manual dispatch                                    | Dependency update maintenance through a GitHub App token                                                                                                        |
| [`release-stable.yml`](../../.github/workflows/release-stable.yml)   | A manual dispatch with `from` and `dry_run` inputs                         | Creates `release/X.Y.x` at a published prerelease and opens its stable release PR, through a GitHub App token                                                   |
| [`backport.yml`](../../.github/workflows/backport.yml)               | A merged `main` pull request is closed or labeled `backport release/X.Y.x` | Opens a PR that cherry-picks the fix onto each labeled release branch, through a GitHub App token                                                               |
| [`land-back-merge.yml`](../../.github/workflows/land-back-merge.yml) | `CI` completes on a `back-merge/**` branch of this repository              | Pushes the back-merge commit to `main` as a fast-forward, through a GitHub App token                                                                            |
| [`codeql.yml`](../../.github/workflows/codeql.yml)                   | A push or PR to `main` or `feat/1153-rust-engine`, or Mondays at 05:37 UTC | CodeQL code scanning for GitHub Actions, Java/Kotlin, JavaScript/TypeScript, Swift and Rust (see [Code scanning](#code-scanning))                               |
| [`cache-cleanup.yml`](../../.github/workflows/cache-cleanup.yml)     | A pull request closes, merged or not                                       | Deletes the Actions caches saved under that pull request's `refs/pull/<n>/merge` ref                                                                            |

The branch workflow accepts pushes to `main` and `release/**`; pull requests,
Renovate updates included, are its usual review path. A newer run for
the same workflow and ref cancels an older run. Diagnose the newest run rather
than treating a cancelled predecessor as a product failure.

Every pull request runs `classify`. Its event payload supplies explicit base and head
commits: PRs use a unique merge base, and pushes compare before/after commits.
Only public Markdown content under `apps/docs-users/src/content/docs/` and
`apps/docs-developers/src/content/docs/` qualifies for `docs-gate`. That gate runs
formatting and the documentation source-contract suite. Unknown events, empty or
unavailable diffs, branch creation, ambiguous merge bases, and every other path
select the full code graph. Configuration, scripts, lockfiles, root documents,
private documentation, and documentation-site code therefore retain full validation.

The `classify` job also runs a `mas` step that decides whether `mas-e2e` runs. For a pull request it
reads the diff against the base and answers `true` when a path under `libs/data-access/auth/`,
`libs/data-access/matrix-client/`, `libs/data-access/accounts/`, `libs/feature/auth/`,
`patches/matrix-js-sdk*` or `e2e/support/homeserver/mas/` changed, when the session or secure storage
service in `libs/platform-native`, the session model in `libs/util/matrix` or the factory reset's
`application-capability.providers.ts` changed, when a MAS journey or its support file changed, when a shared
harness file the MAS stack uses changed (`e2e/support/homeserver/` `Caddyfile`, `start.mjs`, `stop.mjs`,
`constants.mjs`, `kind.mts` or `paths.mjs`), or when a `matrix-js-sdk` or
`@matrix-org/matrix-sdk-crypto-wasm` line changed in `package.json`, `pnpm-lock.yaml` or
`pnpm-workspace.yaml` (a version bump rewrites that dependency's entries; any other dependency leaves the
answer `false`). An empty base commit fails the step instead of answering `false`. Pushes answer `false`:
the Synapse nightly runs the same journeys against `main`. It is a step, not an
`on.pull_request.paths` filter, so a pull request that skips the journeys still reports every required check.

A `scrollbars` step of `classify` decides the same way whether `scrollbars-e2e` runs the scheduled
`components.scrollbars` suite on a pull request. It answers `true` when the diff touches what that suite
imports or renders: `libs/feature/settings/`, `libs/components/overlay/`, `libs/components/navigation-layout/`,
`libs/theme-foundation/` (scrollbar tokens, theme values and the `no-scrollbar` utility), the shared
scrollbar and code-block styles in `apps/trinity/src/global.scss` and `rendered-markdown.scss`, the code
highlighter in `libs/feature/rooms/src/lib/message-presentation/`, the Markdown renderer and sanitizer that emit
the code block's language class and attribute (`message-content.ts` and `message-view.ts` in `libs/util/matrix`),
the message row's template and styles,
`e2e/components/scrollbars/`, its Playwright config, the `trinity-e2e-components` project file, the
E2E registry, or the fixtures, homeserver harness and `e2e/support` files the suite loads, or when a
`@playwright/test`, `playwright`, `tailwindcss`, `@tailwindcss/*`, `shiki` or `@shikijs/*` line changed in
`package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml`. The step lists
them; update it when the suite starts depending on another surface. Pushes answer `false`, and the
suite stays in the scheduled tier, which runs it on `main`. The registry records the job's command as a
`changedPathsOnly` pull-request entrypoint beside the suite's scheduled one.

An `engine` step of `classify` decides the same way whether `engine-contract` runs
`trinity-e2e-engine:contract` against Docker Synapse, with Mailpit and Sydent, on a pull request. It
answers `true` when the diff touches `libs/data-access/`, the libraries the engines build on
(`libs/util/matrix/`, `libs/runtime/`, `libs/platform-native/`, `libs/testing/`), the shared
`vite.base.config.ts` or `test-setup.base.ts`, `e2e/engine/`, `e2e/support/homeserver/`, the `e2e/support`
files on the runner's import path (`invocation.mts`, `managed-command.mts`, `execution-report.mts`,
`session.mts`, `process-lock.mts`, `artifact-path.mts`, `http-failure.mts`, `serve.mjs`) or
`patches/matrix-js-sdk*`, or when a `matrix-js-sdk` or `@matrix-org/matrix-sdk-crypto-wasm` manifest line
changed. Pushes answer `false`: the Synapse nightly's `engine` job runs the contract against `main`. The registry classifies the `engine.js-sdk` suite
as pull-request.

A `rust` step of `classify` decides the same way whether the `rust` and `engine-contract-rust` jobs run on a pull request. It answers `true`
when the diff touches `native/engine*`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `clippy.toml`, `rustfmt.toml`, `deny.toml`, `.cargo/`, the data-access
`src/contract/` files, `probe-homeserver.ts` and `js-sdk-homeserver-engine.ts` in `libs/data-access/homeserver`, `identity-server-http.ts` in `libs/data-access/contact-addresses`, any `rust-dto/`
directory or `*.rust.spec.ts` under `libs/`, the engine transport and `vector-diff.ts` in
`libs/util/matrix`, the engine transport in `libs/testing`, the `libs/testing` index, `synapse-admin.ts`, `rust-account.ts` or `homeserver-proxy.ts`, the shared `vite.base.config.ts` or
`test-setup.base.ts`, `e2e/engine/`, `e2e/support/homeserver/`, or the `e2e/support` files on the runner's import path listed
above. Pushes answer `false`. The `rust` job runs `rustup toolchain install`, then
`cargo fmt --all --check`, `cargo machete` (cargo-machete 0.9.2, installed with `cargo install --locked --version` after the cache step so the cache keeps the binary; it fails on a dependency no crate uses, and `[package.metadata.cargo-machete] ignored` marks a false positive), the `EmbarkStudios/cargo-deny-action` step (cargo-deny 0.20.2, policy in `deny.toml`: RustSec vulnerability, unsound and unmaintained advisories fail for direct and transitive dependencies alike, licences outside the allow list fail, duplicate versions only warn, wildcard versions, git sources and registries other than crates.io fail; a crate that cannot change is listed under `advisories.ignore` with its reason, and `cargo deny check` reproduces it locally), `cargo clippy --workspace --all-targets --locked -- -D warnings`, the same clippy for `trinity-engine` with
`--no-default-features` and `cargo test --workspace --locked` behind a
`Swatinem/rust-cache` cache with the shared key `trinity-engine`, which `engine-contract-rust` restores but never saves. It deletes the generated TypeScript under `libs/**/rust-dto/` before the tests write it again, and
fails when `git status` then reports a modified, deleted or untracked file there. `engine-contract-rust` runs
`trinity-e2e-engine:contract:rust` against Docker Synapse: it builds the stdio test host and runs the `*.rust.spec.ts`
contracts of the libraries in `RUST_LIBS` (`e2e/engine/run.mts`). The registry classifies its `engine.rust` suite as
pull-request and `ciJobOnly`: no aggregate selects it, so `pnpm e2e:protocol` and the Synapse nightly need no Rust
toolchain until piece 2 of #1153 lands on `main`.

The classifier emits its reason and expected jobs. Wiring an aggregate required-result
status into branch rules belongs to the later protection slice
of [#462](https://github.com/quwisky/trinity-matrix-client/issues/462).

Result jobs keep the required check names stable while the work behind them runs in
several jobs. `e2e-result` reports `E2E (Playwright + homeserver)` for `e2e`, the three
`browser-e2e` shards, `storybook`, `mas-e2e`, `tuwunel-oauth-e2e`, `scrollbars-e2e`, `engine-contract`, `engine-contract-rust` and `rust`; `mobile-e2e-result` reports `Mobile E2E (Android)`
for both `mobile-e2e` jobs. A result job passes only when every job it covers succeeded,
so a failed or skipped shard blocks a merge exactly as the single job did. The exceptions
are `mas-e2e`, `tuwunel-oauth-e2e`, `scrollbars-e2e`, `engine-contract`, `engine-contract-rust` and `rust`, which are skipped by design when a pull request leaves the
paths they check alone: `e2e-result` accepts those jobs skipped, while a failed or cancelled run
of any of them and every other skipped job still fail it. Branch rules need no change when a result job gains or loses a job it covers.

### Configure GitHub Pages

In repository Settings → Pages, set the publishing source to **GitHub Actions**.
Protect the `github-pages` environment so only the `main` branch can deploy.
The workflow also checks the exact branch ref before building or deploying, keeps
the build job read-only, and grants `pages: write` plus `id-token: write` only to
the deployment job. It uploads only `dist/docs-site`; pull-request CI validates
the same site without uploading or deploying a Pages artifact.

### Code scanning

CodeQL runs as an advanced setup from [`codeql.yml`](../../.github/workflows/codeql.yml), not
as GitHub's default setup. Default setup analysed `actions`, `java-kotlin` and
`javascript-typescript` but could not include Swift: its Swift autobuild builds the biggest
Xcode target, `ios/App`, and that needs `pnpm install` and `cap sync` first because
`ios/App/CapApp-SPM/Package.swift` points into `node_modules/.pnpm`.

The workflow analyses the three default-setup languages on `ubuntu-latest` with
`build-mode: none`, on every pull request to `main`, every push to `main` and the weekly
run. Rust runs in its own `rust` job on `ubuntu-latest` with `build-mode: none` and the category
`/language:rust`. Its init and analyze steps skip while the tree has no `.rs` file (`hashFiles`),
because CodeQL fails on a tree with no Rust source. Until the Rust engine lands on `main`, the push
and pull request triggers also cover `feat/1153-rust-engine`; the other jobs skip there unless the
ref or the pull request's base is `main`. Swift runs on `macos-26` with `build-mode: manual`: it builds the TrinityPush package
(`libs/native/capacitor-push/ios/TrinityPush`) with `swift build`, and CodeQL analyses what
that build compiles. Because macOS runners cost the most, a pull request runs the Swift job
only when it changes a `.swift` file, a `Package.resolved`, an `.xcodeproj` or
`.xcworkspace`, or `codeql.yml` itself; the `Swift changes` job reads the diff, as the `mas`
step does in `ci.yml`. Pushes to `main` and the weekly run always analyse Swift. No CodeQL
check is required by the `Protect main` ruleset, and a skipped job reports as skipped, so a
pull request that skips Swift waits on nothing.

Swift that CodeQL does not analyse:

- The PushHandoff plugin in `libs/native/capacitor-push/ios/Sources`. Its package depends on
  capacitor-swift-pm's `Capacitor` product alone, and Capacitor's headers import `Cordova`,
  so the package builds only inside the app, where CapApp-SPM also links `Cordova`.
  Adding the `Cordova` product to the plugin's dependencies, as Capacitor's plugin template
  does, makes it build on its own for the iOS Simulator; the workflow could then build and
  analyse it too.
- `ios/App`: the app target and the NotificationService extension. They need the workspace's
  `node_modules` and `cap sync`; `ci.yml`'s `ios-native-build` job compiles them.

Each analysis uploads under the category `/language:<language>`, the category default setup
used, so the alert history of the three existing languages continues. Swift and Rust start
new `/language:swift` and `/language:rust` histories.

Only one setup can upload: while default setup is on, GitHub rejects this workflow's
uploads, so its analyze jobs fail. Before the pull request that adds the workflow merges, a
repository administrator opens **Settings → Code security → Code scanning → CodeQL
analysis** and switches it from **Default** to **Advanced** (or disables default setup
there), then re-runs the pull request's failed CodeQL jobs. If GitHub offers a `codeql.yml`
template while switching, close it without committing: the workflow already exists. The
setting is a separate external action, not something a pull request changes.

### Diagnose setup and cache failures

CI validation jobs and release verification/package jobs use the shared
[setup action](../../.github/actions/setup/action.yml). Renovate uses its own App-token
and container-action setup; the draft-release job consumes artifacts without installing
the workspace, and the macOS signing job installs only `electron/`'s lockfile, with
`--ignore-scripts`.
It installs pinned pnpm before Node.
The pnpm version comes from `packageManager`; Node follows `.nvmrc`; and installation
uses a frozen lockfile. A dependency or lockfile mismatch therefore fails at setup,
before the task that exposed it.

Every Actions cache this repository controls is saved from `main` only. Each job restores with
`actions/cache/restore` and saves with `actions/cache/save` under
`github.ref == 'refs/heads/main'`, skipping the save when the exact key was restored. Any branch
can read the default branch's entries, so pull requests restore main's and add none of their own.
When a pull request changes a key, the Gradle, Appium, apt and emulator caches restore main's
newest entry through their prefix and download the difference; Playwright and Electron use exact
keys, so a new version downloads in full until `main` saves it. Release branches never save
either: a `release/**` push or backport pull request on another Playwright or Electron version
than `main` downloads them in full on every job, an accepted cost for keeping one copy of each
entry. In `mobile-e2e` only shard 1 saves, so the two shards do not upload the same entry. The
[cache cleanup workflow](../../.github/workflows/cache-cleanup.yml) deletes whatever is left
under `refs/pull/<n>/merge` when a pull request closes. CodeQL saves its own caches: each
analysis of `main` adds a `codeql-overlay-base-database-*` entry per language (about 350 MB for
JavaScript, 48 MB for Java) and never deletes the old ones. Left alone they filled the 10 GB
limit and evicted the other entries, the iOS nightly's WebDriverAgent build among them, every
night. The `Prune CodeQL overlay caches` job in [`codeql.yml`](../../.github/workflows/codeql.yml)
therefore runs after the analyses on `main` and keeps only the newest entry per language, which
is the one CodeQL restores. GitHub's off switch for overlay analysis, the
`github-codeql-disable-overlay` custom repository property, needs an organization-owned
repository, and overlay analysis keeps pull request scans incremental, so the job prunes rather
than disables it. The iOS nightly's caches (WebDriverAgent, pip, Appium, Caddy) still use `actions/cache`, which saves
from whatever ref runs it, because that workflow runs on its schedule from `main` or by dispatch.

| Entry                                                          | Saved by                                        | Key changes when                       |
| -------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| `playwright-Linux-chromium-<version>`, `-webkit-`              | `save-playwright`, after the browsers install   | Playwright's version changes           |
| `apt-Linux-<ImageOS>-<ImageVersion>-<version>-chromium webkit` | `save-playwright`, for that set only            | The runner image or Playwright changes |
| `electron-Linux-<electron version>`                            | Desktop jobs, after `pnpm electron:install`     | `electron/package.json`'s Electron pin |
| `gradle-Linux-<hash>`, `appium-Linux-<hash>`                   | `mobile-e2e` shard 1, after a successful run    | The lockfile or Gradle files change    |
| `android-emulator-Linux-36-google_apis-x86_64-…`               | `mobile-e2e` shard 1, after the emulator booted | The emulator or image version changes  |

The pnpm store is not cached: installing from the registry measured as fast as restoring the
store (13–19 s on Linux, 36 s on macOS and 50 s on Windows), and the entries took about 1 GB.
The setup action sets setup-node's `package-manager-cache: false` so nothing caches it
implicitly. There is deliberately no Nx cache sharing
between hosted runners: Nx's local result index is machine-specific, and this
repository has no remote Nx cache. Treat a repeated build in another CI job as
an independent build, not a cache regression. Pull requests instead save
time by testing only affected projects (see the `test` job below); there is still no cache.

Playwright's `--with-deps` installs its host libraries with apt, which once timed out on a slow
Ubuntu mirror. The [Playwright action](../../.github/actions/setup-playwright/action.yml) therefore
points apt at `~/.cache/apt-archives` (a drop-in setting `Dir::Cache::Archives`) and caches the
`.deb` files under `apt-<OS>-<ImageOS>-<ImageVersion>-<Playwright version>-<browsers>`. Only the
default `chromium webkit` set is saved; other sets restore it through the prefix and apt fetches
what they lack. Browsers are cached one entry per browser (Chromium with its headless shell and
ffmpeg, and WebKit), keyed on the Playwright version, so a job asking for Chromium alone and one
asking for both share the Chromium entry. Firefox, used only by the pull-request scrollbar check
and the weekly scheduled run, is downloaded each time. Jobs that install through
`scripts/ci-prerequisites.mjs` (`install: 'false'`) call
[`save-playwright`](../../.github/actions/save-playwright/action.yml) after it. A hit skips the
package downloads; `apt-get update` still fetches the index, and a missing
or corrupt `.deb` is downloaded again, so a stale cache cannot fail the job. A new runner image
version starts a new cache. Each `playwright install` attempt (in the action and in
`scripts/ci-prerequisites.mjs`) is bounded to six minutes and retried once, with a
`::warning::` naming the first failure. The Chromium-only browser shards skip `--with-deps`
through `with-deps: 'false'` and `TRINITY_PLAYWRIGHT_WITH_DEPS`, because the hosted Ubuntu image
already ships Chrome's libraries; every job that installs WebKit keeps the system packages.

The hosted Ubuntu image ships neither the Android emulator nor the API 36 system image, and the
emulator action installs both with one sdkmanager call each, without a retry, so a download that
arrives corrupt (`Error on ZipFile unknown archive`) would fail a `mobile-e2e` job before any
spec runs. The job therefore restores both packages from a cache first; the
`Install the emulator and its system image` step then has sdkmanager install whatever is missing
or outdated, in up to three attempts that each discard the partial download, and checks the
result with `sdkmanager --list_installed`. The action's own sdkmanager calls find both packages
current and download nothing. Cache keys end in the installed emulator version and image revision
(`android-emulator-Linux-36-google_apis-x86_64-<emulator>-r<revision>`) and the newest is restored
by prefix, so a new release is downloaded once and saved under a new key. Only shard 1 of a run
on `main` saves, because the entry is about 2 GB: pull requests restore main's entry, and until
main has one for the current versions they install with the retry alone. Each attempt is bounded
(two minutes for the licences, ten for the install, 40 for the step), and a failed attempt also
deletes both package directories. Packages are saved only after the
emulator booted from them, and files left by a restore that failed part-way are deleted before
the install, so a bad entry cannot reach the emulator. To force fresh downloads, delete the
entries: `gh cache delete <key>`. The job's `TRINITY_EMULATOR_*` variables set the API level,
target and arch for both the emulator action and these steps.

A new emulator or image release saves a second 2 GB entry beside the old one. The repository's
Actions cache is capped at 10 GB and evicts the least recently used entries first, so delete the
superseded entry once the new one exists (`gh cache list --key android-emulator-`, then
`gh cache delete <old key>`).

## The CI jobs

Open the newest workflow run, then start with the first failing step and its
log. Do not infer repository-wide merge rules from the workflow YAML: branch
protection and rulesets live in GitHub settings and may impose additional
requirements.

| Job                     | Checks                                                                                                                                                                                                                                                                                                                                                                                          | First recovery step                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality`               | `pnpm lint`, `pnpm stylelint`, `pnpm format:check`, then the workspace-wide typecheck                                                                                                                                                                                                                                                                                                           | Fix the reported rule, formatting or type error. Stylelint is separate from lint, and a passing Vitest run does not replace the typecheck.                                                                                                                                                                                                                      |
| `test`                  | Unit tests. A pull request tests the projects `nx affected` selects against its base commit; a change to any root-level file or under `.github/` tests every project, as does every push                                                                                                                                                                                                        | Fix the unit failure. To see the selection locally, run `pnpm nx show projects --affected --base=<base sha> --withTarget test`.                                                                                                                                                                                                                                 |
| `renderer`              | One verified production web renderer build, recorded as a SHA/configuration/file manifest artifact                                                                                                                                                                                                                                                                                              | Inspect the renderer workflow's build, manifest, or upload step. Downstream hosts must consume this artifact.                                                                                                                                                                                                                                                   |
| `desktop`               | Electron install, compile, typecheck, unit tests, and launched-shell E2E using the verified renderer                                                                                                                                                                                                                                                                                            | Use the [desktop guide](../../apps/docs-developers/src/content/docs/platforms/electron.md) to reproduce the matching shell or packaging step.                                                                                                                                                                                                                   |
| `e2e`                   | Production renderer, styling, then QR verification against the disposable homeserver, using the verified renderer                                                                                                                                                                                                                                                                               | Read the Playwright report and reproduce the smallest owned journey. Homeserver-backed suites on one machine share a fixed stack, so run them sequentially.                                                                                                                                                                                                     |
| `browser-e2e`           | Disposable-homeserver (Tuwunel) browser journeys as three Playwright shards. Each job sets `TRINITY_E2E_SHARD=<n>/3`, starts its own homeserver and development build, and does not wait for the renderer                                                                                                                                                                                       | Open the failing shard's artifact (surface `browser`, shard `<n>`) and reproduce the failing spec; `TRINITY_E2E_SHARD=<n>/3 pnpm exec nx run trinity-e2e-browser:e2e` replays the whole shard.                                                                                                                                                                  |
| `storybook`             | Component Storybook palette, mode and contrast checks with three workers; no renderer or homeserver                                                                                                                                                                                                                                                                                             | Reproduce with `pnpm exec nx run trinity-e2e-components:storybook`.                                                                                                                                                                                                                                                                                             |
| `mas-e2e`               | MAS-backed OAuth journeys (`accounts/mas-session.spec.mts`) with `TRINITY_E2E_MAS=1`, only when `classify` found sign-in, `matrix-js-sdk` or MAS changes in the pull request; otherwise skipped. The E2E registry pins the browser command line, so `TRINITY_E2E_SPEC` selects the file                                                                                                         | Open the failing job's artifact (surface `browser-mas`). Reproduce with `TRINITY_E2E_MAS=1 pnpm nx run trinity-e2e-browser:e2e -- accounts/mas-session.spec.mts`; the refresh journey alone takes about three minutes.                                                                                                                                          |
| `scrollbars-e2e`        | The scheduled `components.scrollbars` suite in Chromium, Firefox and WebKit against the development build and a disposable homeserver, only when `classify` found settings, overlay, layout, theme, scrollbar or code-block style, Markdown renderer, highlighter, suite or Playwright, Tailwind or Shiki version changes in the pull request; otherwise skipped                                | Open the failing job's artifact (surface `scrollbars`). Reproduce with `pnpm nx run trinity-e2e-components:scrollbars`, or one browser with `-- --project=chromium --workers=1`.                                                                                                                                                                                |
| `engine-contract`       | `trinity-e2e-engine:contract` against Docker Synapse with Mailpit and Sydent, only when `classify` found engine, `libs/util/matrix`, runtime, platform-native, native plugin, testing, shared Vitest config, contract runner, harness or `matrix-js-sdk` changes in the pull request; otherwise skipped                                                                                         | Open the failing job's artifact (surface `engine-contract`): one JUnit and JSON report per library, and the full log under `dist/.ci/`. Reproduce with `TRINITY_E2E_HOMESERVER=synapse pnpm nx run trinity-e2e-engine:contract`.                                                                                                                                |
| `rust`                  | `cargo fmt`, `cargo machete`, `cargo deny`, `cargo clippy` and `cargo test` for the Rust engine workspace, a check that the generated TypeScript under `libs/**/rust-dto/` is committed, and the stdio transport spec of `testing` against the test host it builds, only when `classify` found Rust engine changes in the pull request; otherwise skipped                                       | Reproduce with `pnpm nx run native-engine:cargo-lint`, `cargo machete`, `cargo deny check` and `pnpm nx run native-engine:cargo-test`; the spec with `cargo build -p trinity-engine-testhost`, then `TRINITY_ENGINE_TESTHOST="$PWD/target/debug/trinity-engine-testhost" pnpm nx test testing`.                                                                 |
| `engine-contract-rust`  | `trinity-e2e-engine:contract:rust`: builds the stdio test host and runs the `*.rust.spec.ts` contracts of `RUST_LIBS` against Docker Synapse, only when `classify` found Rust engine changes in the pull request; otherwise skipped                                                                                                                                                             | Open the failing job's artifact (surface `engine-contract-rust`): one JUnit and JSON report per library. Reproduce with `TRINITY_E2E_HOMESERVER=synapse pnpm nx run trinity-e2e-engine:contract:rust`.                                                                                                                                                          |
| `e2e-result`            | Reports the required `E2E (Playwright + homeserver)` check; passes only when `e2e`, every `browser-e2e` shard and `storybook` succeeded and `mas-e2e`, `tuwunel-oauth-e2e`, `scrollbars-e2e`, `engine-contract`, `engine-contract-rust` and `rust` each succeeded or were skipped                                                                                                               | Its log lists each job's result; open the one that did not succeed.                                                                                                                                                                                                                                                                                             |
| `mobile-e2e`            | WebdriverIO and Appium suite against the installed Capacitor app on an API 36 emulator, as two jobs that each select half the specs through `TRINITY_MOBILE_SPECS`. The app build and the homeserver image pull run as background steps while the emulator boots; identifiers are scrubbed before upload                                                                                        | Reproduce with `pnpm e2e:mobile`, or one shard with `TRINITY_MOBILE_SPECS=<its list in ci.yml> pnpm e2e:mobile`; check the uploaded `mobile.android` artifact for the WebView and chromedriver versions line. A failed background build fails the emulator step at its first line; read the `Build the Android app while the emulator boots` step.              |
| `mobile-e2e-result`     | Reports the required `Mobile E2E (Android)` check; passes only when both `mobile-e2e` jobs succeeded                                                                                                                                                                                                                                                                                            | Its log lists each job's result; open the one that did not succeed.                                                                                                                                                                                                                                                                                             |
| `ios-native-build`      | Unsigned iOS Simulator host compile on `macos-26`, using the verified renderer and checking only Cordova extras                                                                                                                                                                                                                                                                                 | Inspect the retained Xcode log and result bundle; this is a compile gate, not installed-device evidence.                                                                                                                                                                                                                                                        |
| `scheduled-e2e`         | Chromium, Firefox, and WebKit scheduled suites, including `components.scrollbars` that `scrollbars-e2e` also runs for matching pull requests                                                                                                                                                                                                                                                    | This weekly Sunday 03:23 UTC job is separate from pull-request jobs; diagnose its browser-specific artifact and environment.                                                                                                                                                                                                                                    |
| `E2E (Synapse nightly)` | Separate `e2e-synapse-nightly.yml` workflow: browser (three shards, like `browser-e2e`), Electron full and protocol suites with `TRINITY_E2E_HOMESERVER=synapse`, daily at 02:47 UTC and on demand; an `engine` job runs the engine contract on its own (`pnpm e2e:protocol` includes it too); a separate `Browser E2E (MAS)` job runs `accounts/mas-session.spec.mts` with `TRINITY_E2E_MAS=1` | Reproduce locally with the same variable, for example `TRINITY_E2E_HOMESERVER=synapse pnpm e2e:browser`. A failure that Tuwunel does not show is a server difference: branch the expectation on `homeserverSession().kind`. Reproduce a MAS failure with `TRINITY_E2E_MAS=1 pnpm nx run trinity-e2e-browser:e2e -- accounts/mas-session.spec.mts`.              |
| `E2E (iOS nightly)`     | Separate `e2e-ios-nightly.yml` workflow on `macos-26`: the mobile suite through XCUITest on the pinned iPhone 17 / iOS 26.5 Simulator, native Synapse, Caddy and Dex (Homebrew `dexidp`, for the SSO spec), caches for WebDriverAgent, pip, Appium and Caddy                                                                                                                                    | Reproduce with `TRINITY_E2E_HOMESERVER=synapse TRINITY_E2E_HOMESERVER_RUNTIME=native pnpm e2e:mobile:ios` on macOS; dispatch with `gh workflow run e2e-ios-nightly.yml -f specs=./specs/<file>.e2e.mts`; read `mobile.ios/host-output` and `wdio/appium.log` in the artifact. A pin missing from a new runner image fails with the available simulators listed. |

A red scheduled run notifies nobody, so `scheduled-e2e` and every job of the Synapse nightly feed a
`notify` job that calls the reusable [`_nightly-alert.yml`](../../.github/workflows/_nightly-alert.yml).
On `main`, a failed (or cancelled) job opens one `Nightly E2E failing: <workflow name>` issue labelled
`ci-nightly`, or reuses the open one, and comments with the run URL, the failed job ids and the date. The
next all-green run comments and closes it. Pull requests and other branches never touch it, and the job
holds only `issues: write`. Because a cancelled job counts as failed, the weekly `ci.yml` run has its own
concurrency group: a push to `main` cancels the in-flight push run but never the scheduled one. Give any
new scheduled E2E workflow the same `notify` job and list it in `scripts/nightly-alert-workflow.spec.mjs`,
which fails until it does.

Started Playwright suites upload hidden `dist/.playwright/` output through the
[diagnostics action](../../.github/actions/upload-playwright-diagnostics/action.yml).
Each artifact identifies the run, attempt, commit, job, surface and shard, with
seven-day retention. HTML, blob, JUnit and GitHub reporting remain enabled in CI;
failed attempts retain traces and screenshots. CI allows one diagnostic retry
and rejects pass-on-retry results.

Uploads run after ordinary failures and managed suite timeouts. A soft timeout
terminates the owned process group before the job deadline, leaving time for
report flushing and upload. Superseded-run cancellation skips uploads. A suite
that never started does not demand a report; a started suite with missing reports
fails diagnostic validation even when process logs are available. Runner loss or
a hard job deadline cannot guarantee an upload, so inspect step logs as well.

The browser prerequisites helper runs browser installation, development build,
and optional Docker pre-pull concurrently, retaining each exit code and labeled
logs under `dist/.ci/`. Browser/build failure is fatal; Docker pre-pull failure is
a warning because suite setup can pull again. Android waits for udev to settle
before checking KVM access. Its Playwright download cache is separate from Gradle.
A failed Renovate run separately uploads `renovate-log.ndjson` for seven days. Renovate writes
that file through the runner's `/tmp` mount because its container does not share the checked-out
workspace with the host-side health check.

### The verified renderer artifact

The reusable [`_renderer.yml`](../../.github/workflows/_renderer.yml) workflow checks
out the calling event's commit, fails unless it is the exact full commit SHA requested by
`ci.yml`, runs one production renderer compilation, and records
`dist/web-bundle-manifest.json` version 2. The manifest binds
the production configuration and every file's path, byte count, and SHA-256; its own
SHA-256, source SHA, immutable artifact ID, and run-bound artifact name are passed to
downstream jobs. The canonical verifier is `node scripts/web-bundle-manifest.mjs`,
with artifact coordinate handling in `node scripts/renderer-artifact.mjs`.

Desktop, Android, iOS, and the production renderer journey download that artifact and
validate its coordinates, manifest digest, file contents, and expected checkout before
installing the payload into the canonical `www/` directory. The native wrappers allow
only their generated Cordova files alongside the manifest payload. A failed validation
does not replace `www/`. The `e2e` and `browser-e2e` jobs build the development bundle while
preparing Docker/browser prerequisites. In `e2e`, the production renderer step restores the
verified artifact afterward, while styling uses the development server. The browser
journeys use only the development server, so `browser-e2e` does not wait for the renderer.

The renderer job and its consumers check out the event's commit without a `ref:` input.
`renderer-artifact.mjs` binds that checkout to the renderer's SHA: every command fails
unless `HEAD` equals `TRINITY_RENDERER_SHA`. CodeQL's
`actions/cache-poisoning/poisonable-step` query treats a `ref:` taken from a workflow
input or job output as untrusted code on `ci.yml`'s schedule trigger, and flags each
local action or script that runs after it.

For local host parity checks against an already recorded artifact, use:

```bash
pnpm ios:build:prebuilt
pnpm android:build:prebuilt
pnpm nx run trinity-e2e-electron:full-prebuilt
pnpm nx run trinity-e2e-electron:smoke-prebuilt
```

These targets require `www/` and `dist/web-bundle-manifest.json` to have been recorded
by the renderer build; they verify before copying or launching and do not create a new
production renderer. On Linux, prefix the Electron targets with `xvfb-run -a` when a
display is required.

For local commands and the distinction between unit, type, renderer, and real
host checks, see [testing](../../apps/docs-developers/src/content/docs/testing/testing-strategy.md) and
[commands](../../apps/docs-developers/src/content/docs/reference/commands.md). Do not turn a timeout or an unavailable
Docker, browser, emulator, or macOS host into a passing result; record the
unavailable prerequisite and the evidence that did run.

## Container prerequisite

The local `trinity-web-container` host exposes `verify`, `build-prebuilt`, and `smoke`
Nx targets for the next CI fan-out step. It checks the existing production renderer manifest
before building the pinned rootless SWS image and proves its HTTP and offline PWA contract
without registry credentials.
See [container validation](../../apps/docs-developers/src/content/docs/platforms/web-and-pwa.md) for commands,
Docker/browser prerequisites, and the native architecture limit. Trinity's existing root and
Electron package licenses remain MIT, with matching OCI metadata and preserved third-party
notices. Releases publish it: `release.yml`'s `package-web` job attaches `Trinity-Web-<version>.zip`
(the verified renderer, `LICENSE` and its web-bundle manifest) to the draft, and
[`container.yml`](../../.github/workflows/container.yml) runs when the release is published. It
verifies that zip against the tag commit, runs `trinity-web-container:smoke` and stages the
image context with a read-only token. Its `publish` job, the only one with the registry token,
installs nothing and pushes that context as `linux/amd64` and `linux/arm64` to
`ghcr.io/quwisky/trinity-web` with `X.Y.Z`, `X.Y` and `latest` (stable) or `X.Y.Z-next.N` and `next` (prerelease). Moving tags only follow the newest release on
their line. To republish, run the Container workflow with the tag; recovery for a cancelled run or a
missing zip is under [Recover a release run](#recover-a-release-run).

The first push creates the package as private. Once, open the repository's **Packages** →
`trinity-web` → **Package settings** and change the package visibility to **Public**; until then
anonymous `docker pull` fails. `latest` exists only after the first stable release is published;
before that, self-hosters use `next`.

## Releases

`main` is the only integration branch. Prereleases are cut from it; a stable line lives on
a `release/X.Y.x` branch cut from a tested prerelease. Both are managed by release-please
through [`release.yml`](../../.github/workflows/release.yml):

| Line       | Branch          | Versions                | Config / manifest                                                        | Notes                                                  |
| ---------- | --------------- | ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| Prerelease | `main`          | `X.Y.Z-next.N`          | `release-please-config.next.json` / `.release-please-manifest.next.json` | GitHub release only (prerelease)                       |
| Stable     | `release/X.Y.x` | `X.Y.Z`, then `X.Y.Z+1` | `release-please-config.json` / `.release-please-manifest.json`           | GitHub release and `CHANGELOG.md`; patch releases only |

On every push to either kind of branch, release-please updates that branch's release PR
from the Conventional Commits since the last release. Release PRs on both lines are titled
`release: cut the vX.Y.Z release` (`pull-request-title-pattern` in both configs), and
release PRs merge as a squash, which keeps that title as the commit; commitlint allows the `release` type. Merging the release PR bumps
`package.json`, `electron/package.json` and the manifest, and release-please then
tags the squash commit and creates a **draft** GitHub release. release-please works with
the release App's token, so the App opens and updates the release PRs, which run
pull-request CI like any other PR, and creates the tags and draft releases; the workflow
token in that job is read-only. No workflow listens for tag pushes or draft creation, and
no workflow script creates or moves a tag. The same workflow run
verifies the tag and attaches the desktop packages to that draft. The `publish`
job then publishes it once every package is attached; see
[Automatic publishing](#automatic-publishing).

Versions: before 1.0, `feat` and breaking changes bump the minor version and `fix`
the patch version on `main`. The prerelease line counts `0.2.0-next.0`, `0.2.0-next.1`, …
until a stable line is cut. The stable config sets `"versioning": "always-bump-patch"`,
so even a `feat` merged into a release branch produces the next patch release. Do not use
`Release-As` commit footers: release-please reads them on every line, so one footer tries
to cut the same version twice.

### Release a stable version

1. Pick a published `vX.Y.Z-next.N` prerelease that has been tested. Run the
   `Release stable` workflow (Actions tab, manual dispatch) with `from` set to that tag
   (empty means the newest published prerelease) and `dry_run` enabled. It runs the checks
   and prints the branch, version and commit it would use, and pushes nothing.
2. Run it again with `dry_run` disabled. It pushes `release/X.Y.x` as exactly the
   prerelease's commit, with no commit of its own. That push runs `release.yml` on the
   branch. While the branch has no stable `vX.Y.*` tag in its history,
   [`scripts/release-version.mjs`](../../scripts/release-version.mjs) takes the newest
   `vX.Y.Z-next.N` tag reachable from it and the `Release PR and tag` job runs the
   release-please CLI (locked by `tools/release-please/pnpm-lock.yaml` and installed with
   `--ignore-scripts`) with `--release-as X.Y.Z`, which opens the
   stable release PR with version `X.Y.Z`, so stable ships exactly the tested code. The
   action then only tags and releases. Every later push before the release (a fix merged
   first, say) keeps the PR at `X.Y.Z` the same way. Once `vX.Y.Z` is tagged, the job runs the action alone and the stable config's
   `always-bump-patch` proposes patch releases.
3. Review the stable release PR (version and `CHANGELOG.md` entry) and merge it. That is
   the last manual step: the tag, draft release and packages follow, and the `publish`
   job publishes the release once every package is attached (see
   [Automatic publishing](#automatic-publishing)).
4. Once `vX.Y.Z` is tagged, the `Open the back-merge PR` job opens the back-merge PR. It
   carries only the release metadata (changelog, manifests, user guide) to `main` as one
   single-parent commit, which lands by a direct push once CI passes on it; no step is
   needed unless the job fails (see [The back-merge](#the-back-merge)).

The same run creates the label `backport release/X.Y.x` for the new line.

Prerequisites for a cut:

- The prerelease must be cut after the release-branch workflows landed on `main` (the
  workflow refuses older ones), and its minor line must not have a release branch yet. In
  practice the first cut is a `0.2.0-next.N` prerelease after a `feat`; `0.1.x` fixes go
  through `release/0.1.x` (see [Migrating from develop](#migrating-from-develop)). A dry run
  before such a prerelease exists is expected to refuse.
- Merge the previous line's back-merge PR first. The new branch's changelog starts at the
  commit of the version in `main`'s `.release-please-manifest.json`, which release-please
  finds by walking history. The back-merge sets that manifest to the line's cut prerelease
  (for example `0.5.0-next.6`), a commit on `main`'s own history, so the next line's notes
  start exactly at the previous cut. The stable tag is not on `main`, so a stable version
  there would stop the walk at the back-merge commit and open no release PR.

The workflow refuses, and creates nothing, when `from` is not a published prerelease on
`main`'s history, when `release/X.Y.x` already exists (land fixes on it; its next stable
release is a patch release), or when a `vX.Y.Z` tag exists. It also refuses a prerelease
whose commit predates `release-stable.yml` or has no `.github/CODEOWNERS`, because a
release branch inherits the workflows and code owners of the commit it is cut from: cut a
new prerelease from `main` first.

It pushes with the release App's installation token, not `GITHUB_TOKEN`: pushes made with
`GITHUB_TOKEN` trigger no workflows, so `release.yml` would never run on the new branch.
The release App is a GitHub App (for example "Trinity Release") installed only on this
repository with Contents, Pull requests and Issues: read & write (labels and pull request
comments use the issues API). Each job mints its token with `permission-*` inputs for only the
scopes it writes with: Contents for `publish` and `land-back-merge.yml`, Contents and Pull
requests for `release-please`, `back-merge` and `backport.yml` (release-please's labels and
comment go on the release PR itself), and Contents and Issues for `cut`. Its
`RELEASE_APP_CLIENT_ID` variable and `RELEASE_APP_PRIVATE_KEY` secret live in the
`release-app` environment, whose deployment branch policy allows `main` and `release/**`;
the jobs that mint the token (`release-please`, `back-merge` and `publish` in `release.yml`, `cut` in
`release-stable.yml`, `backport.yml` and `land-back-merge.yml`) declare `environment: release-app`. Give
`release-app` no required reviewers: they would stall every release PR, cut, publish, back-merge and
backport. Reviewers belong on `release`, where they gate macOS signing only. The release App, not
Renovate, is the only bypass actor for `release/**` in the ruleset, and it is a bypass actor
on `main`'s ruleset so it can push back-merge commits. Renovate keeps its
own App and credentials.

Pushing the branch is the workflow's last step; a failure before it creates nothing, so
rerun it. Once the branch exists, rerunning is refused. If no stable release PR appears on
it, read the `Release PR and tag` job of the `release.yml` run for that push (its
`Find the first stable version` step prints the version it found) and re-run it. If that
run is gone, merge any pull request into `release/X.Y.x` (an empty commit is enough) to
trigger a new one; the version comes from the tags, so any push opens the PR at `X.Y.Z`.
Never force-push.

### Release credentials

Every release credential lives in an environment: the release App key in `release-app`,
the macOS signing and notarization secrets in `release`, the tap deploy key in `homebrew`
and the Renovate App key in `renovate`. An environment admits a job by its ref, so the
rules on those refs decide who can reach the credentials:

- The `Protect release tags` ruleset blocks creating, updating and deleting `v*` tags.
  Only the release App, which tags releases, and the maintainer bypass it. Without the
  creation rule, any writer could push a `v*` tag carrying an edited `homebrew.yml` and
  run it with the deploy key.
- `Protect main` and `Protect release branches` require one approval from someone other
  than the last pusher, dismiss approvals when new commits arrive, and require a code
  owner's review. [`CODEOWNERS`](../../.github/CODEOWNERS) assigns the workflows, the
  scripts the release jobs run, the release-please tooling and configuration, the root
  `package.json` (its `packageManager` picks the pnpm those jobs install) and every file
  directly in `electron/` to the maintainer. The release App and the maintainer bypass
  both rulesets, so release PRs, back-merges and the maintainer's own pull requests merge
  as before. GitHub reads `CODEOWNERS` from the pull request's base branch, so each
  `release/X.Y.x` branch carries its own copy; `Release stable` refuses a prerelease
  without one.
- `release` and `homebrew` require the maintainer's approval for each deployment, so every
  signed macOS build and every tap update waits for it. `release-app` runs on every push
  to `main` and `release/**` and `renovate` runs daily, so neither has reviewers; the
  approval rules on those branches guard them instead.

When a release job starts running a new script or configuration file, add it to
`CODEOWNERS`.

### Release a fix

1. Merge the fix into `main` through its normal pull request and add the label
   `backport release/X.Y.x` (before or after merging).
   [`backport.yml`](../../.github/workflows/backport.yml) opens a pull request into
   `release/X.Y.x` that cherry-picks it. Review and merge that backport PR.
2. release-please opens a release PR on `release/X.Y.x` for `X.Y.Z+1`. Merge it. The
   release publishes itself and the back-merge PR follows and lands itself, as for a
   stable version. A fix release on an older line is published with `--latest=false`, never marked "latest", when a
   higher stable version is published.

A fix that only applies to the release branch can still be opened as a pull request into
`release/X.Y.x` directly. The back-merge carries only release metadata, so `main` does not
receive it: if `main` needs it too, open its own pull request into `main`.

### Backports

`backport.yml` runs on `pull_request_target` for merged pull requests into `main` that carry
one or more `backport release/X.Y.x` labels. It never checks out the pull request's code: it
checks out `main` and cherry-picks the merged commit (with `-x`) onto a branch
`backport/<pr>-release-X.Y.x` cut from the release branch, then opens a pull request titled
`<original title> (backport to release/X.Y.x)`. It mints the release App token in the
`release-app` environment. Adding a label to an already merged pull request backports to
that line only; merging backports to every labelled line. [`scripts/backport.mjs`](../../scripts/backport.mjs) does the work.
The back-merge never carries code, so a backported fix exists once in `main`'s history (its
original commit) and its cherry-pick stays on the release branch.

Never backport a change to `.release-please-manifest.json`. A release branch's stable manifest
is its own; `main`'s copy only marks the next line's boundary. A release line gets release
tooling from a pull request that also changes that manifest (such as the single-parent
back-merge) through a direct pull request into `release/X.Y.x` that carries the tooling
without the manifest, not through a backport label.

- A rebase-merged pull request is picked as its full commit range when its commits' full
  subjects appear in order at the merge point; a squash or merge commit is picked as one
  commit. A multi-commit pull request picked as one commit logs a `::notice::`, expected
  for a squash merge.
- A pick that would be empty (the fix is already on the branch) gets a "nothing to backport"
  comment on the original pull request.
- A conflict, or a label naming a branch that does not exist, opens nothing and comments on
  the original pull request with the manual commands. Other labels still proceed.
- An existing backport branch or pull request is left as is; the job log gives that skip
  reason. A branch that was pushed without a pull request (`gh pr create` failed) is not
  retried: delete it by hand, then re-run the job or re-apply the label.

`pull_request_target` always uses the default branch's copy of the workflow, so backports
start working only after the `develop` to `main` rename (see
[Migrating from develop](#migrating-from-develop)), and the `release-app` environment must
allow `main`.

### Automatic publishing

After `draft-release`, the `publish` job of `release.yml` runs
[`scripts/release-publish.mjs`](../../scripts/release-publish.mjs) with the release App
token (a release published with `GITHUB_TOKEN` would not start the Homebrew, container,
docs or apt workflows). It publishes the draft only when it holds every expected asset: the
arm64 `.dmg` and `-arm64-mac.zip`, the `.exe`, the `.AppImage`, the `.deb` and the
`Trinity-Web-*.zip`. Prereleases publish as prereleases, never "latest"; a stable release
is "latest" only when it is the highest published stable version. It runs for push and
dispatch runs alike and leaves an already published release alone.

A partial draft stays a draft: the job succeeds and prints a warning naming the missing
assets. Fix the cause and dispatch `release.yml` with the same tag; the re-package completes
the draft and the `publish` job publishes it.

### The back-merge

After a stable tag is created on a `release/**` branch, the `Open the back-merge PR` job in
`release.yml` runs [`scripts/back-merge.mjs`](../../scripts/back-merge.mjs). It builds one
commit on top of `origin/main`, on a new `back-merge/vX.Y.Z` branch, and opens a pull request
titled `chore: back-merge vX.Y.Z into main`; the body lists the paths it carried. The commit
has a single parent and no merge of the tag, so backported fixes are not duplicated in
`main`'s history. It pushes only that branch, never the release branch. Rerunning updates an
existing PR, rebuilding the commit from current `main` (a lease-guarded push of the bot's own
branch). It prints "nothing to back-merge" and opens nothing when the rebuilt commit changes
nothing, or when `main`'s `CHANGELOG.md` already contains the `## [X.Y.Z]` heading. Because of
the heading check, metadata that changed after the first back-merge (the section's text, a user
guide page, `release.json`) never reaches `main` by a rerun; open a normal pull request to `main`
for it. The job does not affect
the release itself.

The job runs `main`'s copy of `back-merge.mjs` (a sparse checkout into `main-tools/`) against the
release branch, so the commit is built by the same code the lander rebuilds it with, and a later
change to the script needs nothing on the release lines. Only the job itself lives on the line: a
line whose `release.yml` predates the single-parent job still builds the old two-parent merge,
which the lander refuses. Update that line's `release.yml` through a direct pull request into
`release/X.Y.x` (never with `.release-please-manifest.json`) and re-run `Open the back-merge PR`.

The commit carries only these paths. `CHANGELOG.md` is not merged: the tag's `## [X.Y.Z]`
section is inserted into `main`'s changelog above its first lower version, unless it is already
there, and the rest of `main`'s changelog stays as it is (if `main` has no `CHANGELOG.md`, the
tag's is written whole). `apps/docs-users/release.json` and user guide pages are a 3-way merge
of the merge base, `main` and the tag in which a conflicting hunk takes the release side and
every non-conflicting edit from either side is kept; `release.json` is written back even if
`main` deleted it. Any other path, a user guide page or `.release-please-manifest.next.json`,
that is absent on `main` (or that the tag deleted) is skipped with a note. Renames are not followed: a
moved page counts as deleted at its old path and new at its new one. A path added on both
lines takes the release side whole. `.release-please-manifest.json` is not merged: it gets the
line's cut prerelease, or keeps `main`'s value when that is already a higher `-next` prerelease,
so a patch on an older line never moves `main`'s boundary back. A stable value there predates
single-parent back-merges and is replaced by the cut.

When `main` already records a newer stable release than the tag (a higher `## [X.Y.Z]` in its
`CHANGELOG.md` or a higher `version` in `apps/docs-users/release.json`), as when v0.5.4 ships
after v0.6.0 was back-merged, the commit carries only the tag's changelog section.
`release.json`, the user guide pages and both manifests stay as `main` has them.

| Path                                             | Resolution                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHANGELOG.md`                                   | The tag's own section, inserted in version order                                                                                           |
| `apps/docs-users/release.json`, user guide pages | The release branch's side; untouched for an older line                                                                                     |
| `.release-please-manifest.json`                  | The line's cut prerelease (`git describe --tags --abbrev=0 --match 'v*-next.*' vX.Y.Z`, without the `v`), or `main`'s higher `-next` value |
| `.release-please-manifest.next.json`             | The higher version by semver precedence (`0.1.1` beats `0.1.1-next.3`), so `main` continues at the next patch's prereleases                |

`package.json`, `electron/package.json` and all other paths are never carried, so conflicts
no longer arise. The job fails, with a clear error, only when no cut prerelease tag precedes
the stable tag.

`main` allows only squash merges, so never merge the PR with the button: a squash would
produce a different commit than the one the lander verifies. Instead the PR lands by a direct
push after CI passes. Whenever `CI` completes on a `back-merge/**` branch of this repository,
whatever its conclusion, [`land-back-merge.yml`](../../.github/workflows/land-back-merge.yml)
runs [`scripts/land-back-merge.mjs`](../../scripts/land-back-merge.mjs) with the release App
token, which pushes the branch's head to `main` as a fast-forward, never forced. GitHub then
marks the PR merged. The script refuses, and pushes nothing, unless:

- the branch is still at the commit that CI run tested;
- `release/X.Y.x` exists on `origin` and the `vX.Y.Z` tag is on it, as `release.yml`'s verify
  job requires;
- the head has exactly one parent, the current `main`, and the `vX.Y.Z` tag exists. A
  two-parent merge (from a line whose `release.yml` predates this design) is refused. If
  `main` has moved, re-run the `Open the back-merge PR` job; it rebuilds the commit on
  current `main`, and the new CI run lands it;
- every changed path is release metadata, and at least one changed;
- the commit's tree equals the tree `buildBackMerge(vX.Y.Z)` rebuilds in a temporary worktree
  at the same `main` commit, so a forged branch cannot carry other content;
- every required status check of `main`'s ruleset, read live from the branch rules API, has
  passed (success, skipped or neutral) on that exact commit, judged by its latest GitHub
  Actions run. A failed job that `main` does not require (Desktop, iOS) does not block it;
- exactly one open, non-draft pull request from this repository goes from the branch into
  `main`, its head is that commit, and its review decision is not "changes requested".

These checks run just before the push, not atomically with it. The fast-forward-only push
is what keeps a `main` that moved in between safe: git rejects it and `main` stays as it is.
Because the App bypasses `main`'s ruleset, its pull-request rules do not stop the push; the
script's PR check does. To stop a back-merge from landing, close its PR, mark it draft or
request changes on it.

To build the commit by hand (the job failed, or `main` moved and you cannot re-run it), run
`main`'s script from an up-to-date clone of `main` with Node 24 or newer and
`gh auth` able to push to `back-merge/**` (the pusher must be a bypass actor of that ruleset)
and a clean worktree, because it switches to `origin/main`. It does everything above and opens
the PR ready for review, not as a draft:

```bash
git fetch origin --tags
git switch main && git pull --ff-only
node scripts/back-merge.mjs --tag vX.Y.Z --branch release/X.Y.x
```

Anything else you commit to the branch fails the lander's tree comparison, so fix
`back-merge.mjs` on `main` instead of editing the commit.

The PR opens ready, so `land-back-merge.yml` lands it once CI completes. `land-back-merge.mjs`
refuses a draft PR, so converting the PR to draft (`gh pr ready <number> --undo`) or closing it
stops a land. To land a PR you drafted, mark it ready once CI is green. If a run refused or is gone, re-run the `Land back-merge` workflow once CI is green,
or, as a bypass actor on `main`'s ruleset, land it yourself from an up-to-date clone with Node 24
or newer:

```bash
node scripts/land-back-merge.mjs --branch back-merge/vX.Y.Z   # or --pr N
```

Never merge it with the button and never force-push.

Two earlier two-parent back-merges (`cc78921b` from #1652 and `6d845c6e` from #1690) brought
already-backported commits into `main` a second time. Their PR bodies carry a
`BEGIN_COMMIT_OVERRIDE` block that hides those commits from future release notes. The
`0.5.0-next.6` manifest on `main` is the one-time migration to the new boundary.

### Migrating from develop

One-time steps, in this order, right after the release-branches pull request (which
targets `develop`) merges. Between the merge and the renames, pushes to `develop` do not
run release-please.

1. Close the open release-please PRs on `develop` and `main` and delete their
   `release-please--*` branches.
2. In Settings → Branches, rename `main` to `release/0.1.x`, then `develop` to `main`.
   GitHub retargets open pull requests and keeps `main` as the default branch.
3. Back-merge `v0.1.1` into the new `main` before any other pull request merges into it. `develop`
   never received the old `main` → `develop` back-merge, so without it `main`'s next
   prerelease would be `0.1.1-next.3` rather than one after `0.1.1`. From an up-to-date
   clone, with Node 24 or newer and `gh auth` able to push:

   ```bash
   git fetch origin --tags
   node scripts/back-merge.mjs --tag v0.1.1 --branch release/0.1.x
   ```

   Review the PR it opens; it lands on `main` once CI passes (see
   [The back-merge](#the-back-merge)).

4. Create the release App (see [Release a stable version](#release-a-stable-version)):
   install it only on this repository with Contents, Pull requests and Issues read & write, and add
   the `RELEASE_APP_CLIENT_ID` variable and `RELEASE_APP_PRIVATE_KEY` secret to a new
   `release-app` environment. Limit its deployment branches to `main` and `release/**` and
   do not add required reviewers to it.
5. Update the ruleset to protect `main` and `release/**` with the rules `develop` and
   `main` had, and restrict who can create `release/**` branches to maintainers and the
   release App: the release verifier trusts any commit contained in a `release/*` branch.
   Make the release App, not Renovate, the only bypass actor for `release/**`.
6. Change the deployment rules of the environments: `github-pages`, `homebrew` and `apt`
   (if present) to `main`, plus `release/**` where a job runs from a release tag. The
   `release` environment, which gates macOS signing in `release.yml`, must allow `main` and
   `release/**`; it may have required reviewers, which gate that job only.
7. Update each local clone:

   ```bash
   git branch -m develop main
   git fetch origin
   git branch -u origin/main main
   git remote set-head origin -a
   ```

8. Before a fix release on 0.1: the renamed `release/0.1.x` still has the old workflows.
   Port `release.yml`, `release-please-config.json` (with
   `"versioning": "always-bump-patch"`), `scripts/back-merge.mjs` and
   `scripts/release-publish.mjs` to `release/0.1.x` through a pull request first.
9. Verify with a `dry_run` of `Release stable`, then the first real cut, and the first fix
   on `release/0.1.x`, each followed by its back-merge PR.
10. Settings for automatic publishing, back-merges and backports:
    - Make `main` squash-only with a back-merge route, in this order, so a back-merge
      always has one way to land:
      1. Add the release App as a bypass actor on the `Protect main` ruleset, so
         `land-back-merge.yml` can push back-merge commits. The script never forces, so the
         bypass is used only for fast-forwards.
      2. Add a ruleset on `refs/heads/back-merge/**` with the creation, update, deletion and
         non-fast-forward rules, and the release App and the maintainer as its bypass
         actors, so no other writer can stage a back-merge.
      3. Set the `Protect main` ruleset's allowed merge methods to squash only.
      4. Turn off "Allow merge commits" in the repository settings. Release-please PRs and
         every other PR then merge as a squash.
    - Require the CI status checks on `main`; `land-back-merge.mjs` reads them live and
      waits for all of them.
    - Create the label `backport release/0.1.x`
      (`gh label create "backport release/0.1.x" --force`); `Release stable` creates the
      label for later lines (if that step fails it only warns; create the label by hand).
    - Confirm the release App has Issues read & write and the `release-app` environment
      allows `main` and has no required reviewers; backports run only once the default branch carries `backport.yml`.

### First release

This describes the original bootstrap under the old develop/main model.

`0.1.0` predates release-please. After the migration merge, push the `v0.1.0`
tag on the migration commit **first**, then create `main` from that commit, and
create a draft `v0.1.0` release for it (`gh release create v0.1.0 --draft --verify-tag --notes "Initial release"`; the body must not be empty,
or the release-notes build finds no notes for the version), then
dispatch `release.yml` with `tag: v0.1.0` to build it. In the other order,
the stable line's first run finds no `v0.1.0` release and proposes a stable release for
whatever reached the integration branch after the bootstrap commit. Both configs carry a
`bootstrap-sha` so release-please's first runs do not read the project's whole
history; once the `v0.1.0` release exists it no longer matters.

The stable release PR also bumps the user guide: `version` in
`apps/docs-users/release.json` and every version string on its pages. Mark a version on
a page with `x-release-please-version` on its line, or wrap the body in
`x-release-please-start-version` / `x-release-please-end` comments; the updater replaces
only the first version on each line. `scripts/user-guide-release-version.spec.mjs`
rejects unmarked versions. Prereleases leave the user guide alone. The developer
guide always deploys from `main`. Between merging the back-merge PR and publishing the release,
`docs-pages.yml` builds the user guide from the newest commit whose version is
published, and publishing the release re-runs the workflow on `main` to switch it.

The release verifier checks the tag format, ancestry and both manifest versions.
Ancestry shows that the commit is contained in `main` or a `release/*` branch; it does not
by itself prove that a pull request was reviewed or every required check passed.

### What the release verifier runs

The verifier runs lint, Stylelint, format checking, `pnpm test`, a production
web build, and Electron typecheck and unit tests. It does **not** run the
workspace-wide typecheck, Storybook, production-renderer, browser E2E, Android
or iOS E2E, or launched Electron E2E. Select extra evidence according to the
change before merging the release PR, following [testing](../../apps/docs-developers/src/content/docs/testing/testing-strategy.md).

## Package and review the draft

The `release-notes` job reads the draft release body with the release App token and hands it to
`package`, `desktop-shell` and `package-web` as `TRINITY_CURRENT_RELEASE_NOTES`, because their
read-only token cannot see a draft. They build with `TRINITY_RELEASE_NOTES=required`, so a
notes failure fails the build. A dispatch therefore re-packages an existing release, draft or
published, only: for a tag without one, `release-notes` fails and the builds are skipped. Android and iOS builds run locally after publishing: set
`TRINITY_RELEASE_NOTES=required` and `GITHUB_TOKEN=$(gh auth token)`.

After verification, the package matrix builds the desktop shell with publishing
disabled and without any signing secret, and packages the Linux and Windows installers. The
`desktop-shell` job builds the same compiled shell and renderer on Linux, and the `sign-mac`
job packages, signs and notarizes it for macOS without waiting for the matrix. The jobs
upload these artifacts for 30 days:

| Host    | Current artifacts                                                             | Distribution boundary                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux   | AppImage and `.deb`                                                           | The workflow packages them; it does not publish them to a download service.                                                                                              |
| macOS   | `.dmg` and `.zip` from `sign-mac`, using the `macos-26` runner's default arch | Signing and notarization depend on configured credentials. Verify the archive architecture before merging the release PR; `publish` only checks that assets are present. |
| Windows | NSIS `.exe`                                                                   | The workflow packages the installer; distribution remains a maintainer action.                                                                                           |
| Web     | `Trinity-Web-<version>.zip` from the `package-web` job                        | Publishing the release runs `container.yml`, which pushes the image built from this zip to GHCR.                                                                         |

The `draft-release` job creates or updates a **draft** GitHub release, and the `publish`
job then publishes it when every expected asset is attached (see
[Automatic publishing](#automatic-publishing)). A partial package matrix produces a draft
containing the successful platform artifacts and a partial-release warning, and the draft
stays a draft. Inspect each available artifact and the failed platform, fix the cause and
re-package the tag. The workflow does not update an auto-updater feed, upload to mobile
stores, or check signing status for you.

A `-next` tag packages **Trinity Next**: `electron/electron-builder.config.ts` merges
`electron/electron-builder.next.yml` (app ID `dev.trinityproject.trinity.next`, product
name, URL scheme, Linux package `trinity-next`, NEXT-badged icons) onto
`electron-builder.yml`; a stable tag packages `electron-builder.yml` as written. Both lines
keep the same file names, so the `publish` asset checks and the Homebrew asset name are
unchanged. See [release channels](../../apps/docs-developers/src/content/docs/platforms/electron.md#release-channels).

> [!WARNING]
> Merging a release PR now publishes the release without a further confirmation. Confirm
> authorization, the release notes and signing status before merging it.

### Signing and notarization

Only the `sign-mac` job reads the signing secrets, and only it uses the GitHub `release`
environment. It installs `electron/`'s own lockfile with `--ignore-scripts` and runs
electron-builder with its config (`electron-builder.config.ts`, which reads the YAML files
and `src/release-channel.ts` from the checkout) and its `afterPack` hook on the shell the
`desktop-shell` job built. It downloads that artifact outside the checkout and copies only
`dist` and `www` into `electron/`, failing if the artifact holds anything else or a symbolic
link. No workspace install, Nx or renderer build runs next to the certificate.
electron-builder signs and notarizes only while it packs, never a `--prepackaged` app, which
is why the packing moved into this job.
`scripts/release-workflow.spec.mjs` keeps every signing secret name out of all other jobs.
Store the signing secrets in the `release` environment rather than as repository secrets, so
no other job can read them.

The environment's presence in YAML does not prove that required reviewers or environment
protections are configured; maintainers must check the repository settings before relying
on them. Reviewers on `release` gate macOS signing only: the release App jobs run in
`release-app`.

The workflow recognizes these secret names only:

- macOS signing: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`
- macOS Apple ID notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`

Without them, `sign-mac` produces unsigned macOS artifacts. Windows signing is not wired
up: the Windows leg builds without credentials, and adding them needs a signing job like
`sign-mac`.

An unsigned Windows installer may be published. Windows SmartScreen shows
"Windows protected your PC" until the user chooses **More info → Run anyway**,
and SmartScreen reputation does not carry over to a later signed build. Say in
the release notes that the Windows installer is unsigned.
The notarization hook skips when no complete credential set is available and
fails when supplied credentials are rejected. The local hook also supports an
API-key credential form, while the committed release workflow supplies the
Apple-ID form above. Use the detailed [desktop signing and notarization
instructions](../../apps/docs-developers/src/content/docs/platforms/electron.md) when preparing those credentials; do not
put their values in issues, logs, or documentation.

Android and iOS retain independent `1.0` / build-code values and are not part
of the current release version gate. Their build and distribution requirements
belong to the [Android](../../apps/docs-developers/src/content/docs/platforms/android.md)
and [iOS](../../apps/docs-developers/src/content/docs/platforms/ios.md) guides.

## Homebrew tap

Publishing a release runs [`homebrew.yml`](../../.github/workflows/homebrew.yml),
which writes the cask to the `quwisky/homebrew-trinity` tap: `trinity` for stable
releases and `trinity@next` for `-next` prereleases. The stable cask follows only the
repository's latest release: a patch on an older line (for example `v0.1.3` after
`v0.2.0`) ends with a notice and leaves `trinity` untouched. Users install with
`brew install --cask quwisky/trinity/trinity` (or `…/trinity@next`). The casks are
Apple Silicon only and require macOS 13. `trinity` installs `Trinity.app` and
`trinity@next` installs `Trinity Next.app`, so both can be installed at once. Each cask's
`zap` removes only its own app's data folder, caches, logs, preferences and saved state.
The job verifies the app its cask installs. For a `trinity@next` user whose installed
version predates Trinity Next, `brew upgrade` replaces the old prerelease `Trinity.app`
with `Trinity Next.app`; a prerelease installed by hand stays as "Trinity".

The job refuses any app that is not signed with a Developer ID, notarized, and
stapled (`codesign`, `spctl`, `stapler` in the step "App is signed, notarized and
stapled"). It audits the generated cask with `brew style` and `brew audit` before
pushing, and pushes nothing when the cask is unchanged. It also checks that the
app's minimum macOS is still 13.0, because `brew audit` requires the cask to match
it exactly. The job maintains `audit_exceptions/github_prerelease_allowlist.json` in
the tap, which `trinity@next` needs because it points at GitHub prereleases.

To rewrite a cask, for example after fixing the tap, dispatch `homebrew.yml` with the
published tag. Only the latest release of each line can be repaired: the audit's
livecheck rejects a cask whose version is older than the newest matching release.
Releases are tagged on the commit release-please merged, so a release whose tagged
commit predates `homebrew.yml` never triggers it; dispatch it from `main` instead.

### One-off setup

1. Join the Apple Developer Program, create a **Developer ID Application**
   certificate, export it as `.p12`, and create an app-specific password. Set the
   `release` environment secrets `MAC_CSC_LINK` (base64 of the `.p12`),
   `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
   `release.yml` fails the macOS signing job when only some of them are set.
2. Create the public repository `quwisky/homebrew-trinity` **with an initial commit**
   (a README is enough); checkout and push fail on an empty repository.
3. Create the environment `homebrew` in this repository. Under deployment branches
   and tags, allow only `main` and tags matching `v*`, and add the
   maintainer as a required reviewer (see [Release credentials](#release-credentials)).
4. Run `ssh-keygen -t ed25519 -C homebrew-trinity -f homebrew-trinity`. Add
   `homebrew-trinity.pub` to the tap as a deploy key **with write access**, and store
   the private key as the **environment** secret `HOMEBREW_TAP_DEPLOY_KEY` in
   `homebrew`. Delete the local key files afterwards.

| Failure                                                    | Recovery                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "is not a published release" (step "Release is published") | The release is still a draft, so `publish` found missing assets (its warning names them). Re-package the tag with `release.yml`; `publish` then completes it.                                                                                                                                           |
| Missing `-arm64-mac.zip` asset                             | The macOS package failed. `release.yml` refuses to change a published release, so either cut a new version, or set the release back to draft (`gh release edit <tag> --draft=true`) and dispatch `release.yml` with the tag; the `publish` job republishes it once complete, which runs `homebrew.yml`. |
| Signing gate fails                                         | The app is unsigned or not notarized. Set all macOS signing secrets, and release a new version; it publishes itself.                                                                                                                                                                                    |
| `brew style` / `brew audit` fails                          | Fix `scripts/homebrew-cask.mjs` and its test, merge, then dispatch `homebrew.yml` with the tag.                                                                                                                                                                                                         |

### Trinity Next transition (once, after it merges)

The stable cask in the tap still says `conflicts_with cask: "trinity@next"` until it is
re-rendered, and `homebrew.yml` re-renders it only for a stable release or a dispatch.
After the change that made Trinity Next its own app merges, the owner:

1. Dispatches the "Homebrew" workflow from `main` with the current stable tag, so the
   stable cask drops the conflict and gains the new `zap` list:

   ```bash
   gh workflow run homebrew.yml --ref main -f tag=v0.4.0
   ```

   Until then `brew install --cask quwisky/trinity/trinity` fails while `trinity@next` is
   installed. Even afterwards, a user who still has the old `trinity@next` (the old
   `Trinity.app`, at the same path as stable's) cannot install `trinity` until they
   upgrade `trinity@next`. That cask keeps its old `conflicts_with cask: "trinity"` until
   the first Trinity Next prerelease publishes and re-renders it.

   A `v0.4.x` patch release undoes this: `homebrew.yml` runs on the published release
   from the tagged commit, and `release/0.4.x` still renders the stable cask with
   `conflicts_with cask: "trinity@next"`. After any `v0.4.x` patch publishes, dispatch
   the workflow from `main` again with that tag:

   ```bash
   gh workflow run homebrew.yml --ref main -f tag=<that tag>
   ```

2. Adds the release note by hand to the release-please PR of the first `-next` release
   that contains the change. Edit its body last, immediately before merging it:
   release-please regenerates the body on every push to `main`, and merging publishes the
   release. The note:

   > The desktop prerelease is now its own app, Trinity Next, with its own icon, data
   > folder and sign-in, so it installs alongside Trinity and both can run at once.
   > Trinity Next starts empty: sign in again, as a new device. A prerelease installed by
   > hand before this one stays installed as "Trinity"; remove it if you do not use stable
   > Trinity. Homebrew replaces it on upgrade.

Skip step 1 if a stable release from a branch that contains the change (`release/0.5.x`
or later) has already published the stable cask. A `v0.4.x` patch never counts: its
cask still conflicts, so it always needs the re-dispatch above.

## Recover a release run

| Situation                                                                                                   | Recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tag is not reachable from `main` or a `release/*` branch, or does not match both manifests                  | Fix the cause through a normal pull request; release-please then proposes a new version. Do not retarget or reuse an existing tag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A platform package fails but other packages succeed                                                         | Inspect the failed matrix log and the `publish` job's warning, which names the missing assets. After a transient runner, credential, or service fix, dispatch `release.yml` with the same tag; `--clobber` replaces the draft's assets and `publish` completes it. A source fix needs a new release.                                                                                                                                                                                                                                                                                                                                       |
| Every package fails                                                                                         | For a transient failure, dispatch the same tag again. For a source or manifest failure, fix it through a normal pull request and release the next version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Container run cancelled (a newer publish queued behind it)                                                  | A third run queued in the `container` group cancels the pending one, so that release has no image. Dispatch the Container workflow with its tag once the queue is clear.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Container workflow: no `Trinity-Web-<version>.zip` asset                                                    | `package-web` failed and the draft was published anyway. Set the release back to draft (`gh release edit <tag> --draft=true`) and dispatch `release.yml` with the tag; the `publish` job republishes it once complete, which runs `container.yml`.                                                                                                                                                                                                                                                                                                                                                                                         |
| A draft-release upload fails                                                                                | Dispatch `release.yml` with the same tag after diagnosing the failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| release-please fails or opens no release PR                                                                 | Read the `Release PR and tag` job log. Only `feat`, `fix`, `perf`, `revert`, `deps` and breaking commits produce a release; `chore`, `ci`, `docs`, `test`, `build`, `refactor` and `style` alone do not. A new release branch's first release PR is the exception: re-run the job, or push to the branch, as in [Release a stable version](#release-a-stable-version).                                                                                                                                                                                                                                                                     |
| A **draft** (never published) release fails Verify on a tooling-only defect (a test or script, not the app) | Fix the defect through a pull request on `main` and backport it to `release/X.Y.x`. Then move the tag to the branch's new head (`git push --force origin <sha>:refs/tags/vX.Y.Z`); GitHub detaches the draft, so reattach it (`gh api -X PATCH repos/<owner>/<repo>/releases/<id> -f tag_name=vX.Y.Z`), dispatch `release.yml` with the tag, and close the patch release PR the backport opened. A moved tag needs no re-back-merge. Release metadata that changed after the first back-merge reaches `main` through a normal pull request to `main` (see [The back-merge](#the-back-merge)). Never do this once the release is published. |
| The release is already published                                                                            | The workflow refuses to replace its assets. Release the next version instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Release runs share one concurrency group and never cancel each other: an
incomplete draft is worse than a slower package run, and two runs must not upload
to the same draft at once. A push queued behind a running release waits; a newer
push replaces an older queued one, which loses nothing because each run reads the
branch as it is. A manual dispatch re-packages an existing tag;
it is not a way to bypass the tag-format, version or ancestry checks. It rebuilds
the tagged source, so a source or manifest correction needs a new release.

Fresh builds include generated build information, so packages from the same
commit are not guaranteed to be byte-identical. Compare the release workflow's
inputs, artifact names, signatures, and intended version rather than claiming a
re-run is reproducible by hash alone.

## Renovate and the trigger it silently depends on

Renovate runs daily at 00:00 UTC and can be manually dispatched with a dry-run
and log-level choice. It reads [`.github/renovate.json`](../../.github/renovate.json)
and authenticates with the `RENOVATE_APP_CLIENT_ID` repository variable and the
`RENOVATE_APP_PRIVATE_KEY` secret of the `renovate` environment, which deploys from `main`
only; `scripts/renovate-config.spec.mjs` keeps every other job from reading the key. Those
names identify setup inputs only; never copy their values into a ticket or log.

The workflow uses a GitHub App token instead of the default workflow token so
the update pull requests can start CI. Its health check requires a completed
repository log and, outside dry runs, an open Dependency Dashboard. For a
failure, start with the `renovate-log` artifact and the workflow's failed health
check rather than assuming a zero exit status means an update was considered.

Capacitor's `cap sync` writes each native plugin's pnpm virtual-store folder, version and
peer suffix included, into `ios/App/CapApp-SPM/Package.swift` and
`android/capacitor.settings.gradle`, and pins `capacitor-swift-pm` to the installed `@capacitor/ios`. The iOS and Android CI jobs fail when a fresh sync
changes them. Renovate only regenerates the lockfile, so a `postUpgradeTasks` rule runs
`node scripts/sync-native-plugin-paths.mjs` on every Capacitor branch and on the Monday lock-file maintenance branch to rewrite those paths and the pin
from `pnpm-lock.yaml`. The workflow's `RENOVATE_ALLOWED_COMMANDS` allows that one command
and nothing else; a refused or failing run shows as an artifact error on the pull request.
`scripts/sync-native-plugin-paths.spec.mjs` fails ordinary CI when the paths drift; run the
script without `--check` to repair them by hand.

Renovate rebases each branch on its next run after `main` moves
(`rebaseWhen: behind-base-branch`), not only on a conflict, which keeps each lockfile current
between runs. The cost is a fresh CI run on every open Renovate pull request after each merge
to `main`. It does not prevent a same-day merge race: #1629 and #1630 merged 19 seconds apart
with lockfiles generated against an older `main`, neither conflicted as text, and together
they broke every frozen install (ajv-formats). Renovate runs once a day, so it cannot rebase
between two merges that close.

Until strict up-to-date checks are on for `Protect main`, after merging a Renovate pull
request, tick **rebase** on the other open Renovate pull requests (or dispatch the Renovate
workflow) and let their CI finish before merging another one. Turning strict checks on is the
real guard, and it is a maintainer action.

### Apply the update policy

The committed [Renovate policy](../../.github/renovate.json) applies a
three-day minimum release age before its exceptions. Use this table when
reviewing an update branch or diagnosing why it did not merge.

Renovate titles every update `deps: update <package> to <version>`, and its pull request
title becomes the squash commit. `deps` is a visible section (`Dependencies`) in both
release-please configs, so an update reaches the release notes and, like any visible type,
can open a release PR on its own. A security update is `fix(deps)` and lands under Fixed.
The `deps` type comes from a package rule matching every package: `config:recommended`
sets `chore`, `fix` or `build` per dependency type and its rules come first, so a
top-level `semanticCommitType` alone loses to them. Lock-file maintenance is a `deps`
commit too.

| Update                        | Current behavior                                                                                                                                                                                                                                                                                                                                                                             | Maintainer action                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Ordinary non-patch dependency | Waits for Dependency Dashboard approval and opens a pull request.                                                                                                                                                                                                                                                                                                                            | Approve the dashboard entry, then review CI.                                              |
| Patch dependency              | After the three-day age, skips the dashboard gate and opens a pull request on `renovate/patch-*`. Nothing automerges: `Protect main` requires an approval and Renovate is not a bypass actor.                                                                                                                                                                                                | Review CI and merge the pull request.                                                     |
| Security update               | Bypasses the dashboard gate, waits one day instead of three and opens a labeled pull request on `renovate/*`. It does not automerge.                                                                                                                                                                                                                                                         | Review the security details Renovate links and merge the pull request promptly.           |
| Shipped runtime package       | `dompurify`, `katex`, `matrix-js-sdk`, `@matrix-org/matrix-sdk-crypto-wasm`, `matrix-widget-api` and `electron` patches open a pull request on `renovate/runtime-*` without the dashboard gate, and keep `automerge: false` should a patch automerge return. Security updates for them open on `renovate/*`. `katex` is pinned exactly, as the `@shikijs/*` packages are, because it is 0.x. | Review the upstream changes and merge the pull request by hand.                           |
| GitHub Actions digest         | Stays behind dashboard approval and keeps `automerge: false`.                                                                                                                                                                                                                                                                                                                                | Review the changed pinned action digest before approval.                                  |
| Native platform dependency    | Stays behind dashboard approval.                                                                                                                                                                                                                                                                                                                                                             | Use the evidence described in the developer native platform guides before approval.       |
| TypeScript                    | Moves root and `electron/` manifests together in the `typescript` group, pinned below `6.1.0` for Angular 22's compiler window.                                                                                                                                                                                                                                                              | Widen that bound deliberately with an Angular upgrade; do not split the Electron version. |

An agent asked to integrate open updates applies them on its own branches and pull requests
rather than merging Renovate's. It gives each update that needs its own review a pull request of
its own: a shipped runtime package, a major version, an Actions digest, a native dependency,
`nx`, `pnpm` and lockfile maintenance. The rest go in one batch. Once the maintainer merges one of those pull requests,
it closes each Renovate pull request it supersedes with "Integrated into main in #N.". It ticks
Dependency Dashboard approvals only when the maintainer asks.

## Source of truth

The executable contracts are [`ci.yml`](../../.github/workflows/ci.yml),
[`docs-pages.yml`](../../.github/workflows/docs-pages.yml),
[`release.yml`](../../.github/workflows/release.yml),
[`release-stable.yml`](../../.github/workflows/release-stable.yml),
[`renovate.yml`](../../.github/workflows/renovate.yml),
[`codeql.yml`](../../.github/workflows/codeql.yml),
[`electron-builder.yml`](../../electron/electron-builder.yml), which notarizes signed macOS
builds with electron-builder's built-in notarization, and
[`electron-builder.config.ts`](../../electron/electron-builder.config.ts) with
[`electron-builder.next.yml`](../../electron/electron-builder.next.yml), which choose each
release line's app identity. Keep this guide aligned
with those files when a trigger, job, artifact, or credential name changes.
