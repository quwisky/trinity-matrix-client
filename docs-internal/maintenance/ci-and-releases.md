# CI and releases

This private guide is for maintainers diagnosing automation and preparing a desktop
release. It describes the workflows that are committed today. It does not
authorize a release, a tag, a workflow dispatch, a settings change, or the use
of a signing credential; those are separate external actions.

For checkout, local commands, branch rules, and validation selection, use the
public developer guide.

## Know what ran

| Workflow                                                   | Starts when                                                       | What it provides                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| [`ci.yml`](../../.github/workflows/ci.yml)                 | A pull request, selected pushes, or its weekly schedule           | Branch checks and browser, desktop, and Android evidence       |
| [`docs-pages.yml`](../../.github/workflows/docs-pages.yml) | A `develop` push or manual dispatch from `develop`                | Validated user and developer sites deployed to GitHub Pages    |
| [`release.yml`](../../.github/workflows/release.yml)       | A stable `vX.Y.Z` tag push, or a manual dispatch with a tag input | Tag verification, desktop packages, and a draft GitHub release |
| [`renovate.yml`](../../.github/workflows/renovate.yml)     | Daily at 00:00 UTC or a manual dispatch                           | Dependency update maintenance through a GitHub App token       |

The branch workflow accepts pushes to `develop`, `master`, and
`renovate/patch-**`; pull requests are its usual review path. A newer run for
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

The classifier emits its reason and expected jobs. The tested required-result
evaluator rejects failed, cancelled, missing, or skipped expected jobs; wiring
that aggregate status into branch rules belongs to the later protection slice
of [#462](https://github.com/quwisky/trinity-matrix-client/issues/462).

### Configure GitHub Pages

In repository Settings → Pages, set the publishing source to **GitHub Actions**.
Protect the `github-pages` environment so only the `develop` branch can deploy.
The workflow also checks the exact branch ref before building or deploying, keeps
the build job read-only, and grants `pages: write` plus `id-token: write` only to
the deployment job. It uploads only `dist/docs-site`; pull-request CI validates
the same site without uploading or deploying a Pages artifact.

### Diagnose setup and cache failures

CI validation jobs and release verification/package jobs use the shared
[setup action](../../.github/actions/setup/action.yml). Renovate uses its own App-token
and container-action setup; the draft-release job consumes artifacts without installing
the workspace.
It installs pinned pnpm before Node because Node's pnpm cache lookup invokes pnpm.
The pnpm version comes from `packageManager`; Node follows `.nvmrc`; and installation
uses a frozen lockfile. A dependency or lockfile mismatch therefore fails at setup,
before the task that exposed it.

The pnpm cache key covers both `pnpm-lock.yaml` and `electron/pnpm-lock.yaml`.
The desktop shell is a second pnpm project, so omitting its lockfile makes its
dependency changes miss cache saves. There is deliberately no Nx cache sharing
between hosted runners: Nx's local result index is machine-specific, and this
repository has no remote Nx cache. Treat a repeated build in another CI job as
an independent build, not a cache regression.

## The CI jobs

Open the newest workflow run, then start with the first failing step and its
log. Do not infer repository-wide merge rules from the workflow YAML: branch
protection and rulesets live in GitHub settings and may impose additional
requirements.

| Job                | Checks                                                                                                          | First recovery step                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality`          | `pnpm lint`, `pnpm stylelint`, and `pnpm format:check`                                                          | Fix the reported rule or formatting issue. Stylelint is separate from lint.                                                                           |
| `test`             | Workspace-wide typecheck, then `pnpm test`                                                                      | Fix the type or unit failure; a passing Vitest run does not replace the typecheck.                                                                    |
| `renderer`         | One verified production web renderer build, recorded as a SHA/configuration/file manifest artifact              | Inspect the renderer workflow's build, manifest, or upload step. Downstream hosts must consume this artifact.                                         |
| `desktop`          | Electron install, compile, typecheck, unit tests, and launched-shell E2E using the verified renderer            | Use the [desktop guide](../../apps/docs-developers/src/content/docs/platforms/electron.md) to reproduce the matching shell or packaging step.         |
| `e2e`              | Component Storybook, production renderer, styling, disposable-Synapse browser journeys, then QR verification    | Read the Playwright report and reproduce the smallest owned journey. The Synapse-backed flows use a fixed disposable stack, so run them sequentially. |
| `android-e2e`      | Four API 36 Pixel 6 WebView shards using the verified renderer                                                  | Use the [Android guide](../../apps/docs-developers/src/content/docs/platforms/android.md) and the Android-specific failure output.                    |
| `ios-native-build` | Unsigned iOS Simulator host compile on `macos-26`, using the verified renderer and checking only Cordova extras | Inspect the retained Xcode log and result bundle; this is a compile gate, not installed-device evidence.                                              |
| `scheduled-e2e`    | Chromium, Firefox, and WebKit scheduled suite                                                                   | This weekly Sunday 03:23 UTC job is separate from pull-request jobs; diagnose its browser-specific artifact and environment.                          |

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

To exercise diagnostic failure handling explicitly after installing Chromium, run
`node scripts/ci-diagnostics-proof.mjs` with `always-fail`, `retry`, `soft-timeout`,
or `missing-report`. These disposable browser fixtures use the shared reporting
policy through pnpm, Nx and the invocation owner. Successful proof intentionally
returns a nonzero status and records `verified: true` in its ignored
`dist/.playwright/ci-proof/evidence/` summary. The timeout case must interrupt a
running test; a normal test timeout or a hang after reporting does not qualify.
These real-browser proofs are separate from the browser-free scripts test gate.

### The verified renderer artifact

The reusable [`_renderer.yml`](../../.github/workflows/_renderer.yml) workflow checks
out the exact full commit SHA requested by `ci.yml`, runs one production renderer
compilation, and records `dist/web-bundle-manifest.json` version 2. The manifest binds
the production configuration and every file's path, byte count, and SHA-256; its own
SHA-256, source SHA, immutable artifact ID, and run-bound artifact name are passed to
downstream jobs. The canonical verifier is `node scripts/web-bundle-manifest.mjs`,
with artifact coordinate handling in `node scripts/renderer-artifact.mjs`.

Desktop, Android, iOS, and the production renderer journey download that artifact and
validate its coordinates, manifest digest, file contents, and expected checkout before
installing the payload into the canonical `www/` directory. The native wrappers allow
only their generated Cordova files alongside the manifest payload. A failed validation
does not replace `www/`. The `e2e` job still builds its development bundle while
preparing Docker/browser prerequisites; the production renderer step restores the
verified artifact afterward, while styling and browser journeys intentionally use the
development server.

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
without registry credentials. The current workflow does not yet invoke this consumer.
See [container validation](../../apps/docs-developers/src/content/docs/platforms/web-and-pwa.md) for commands,
Docker/browser prerequisites, and the native architecture limit. Trinity's existing root and
Electron package licenses remain MIT, with matching OCI metadata and preserved third-party
notices. Container publication remains release work.

## Releases

An authorized release begins with the repository's normal review process.
Before creating a tag:

1. Make a dedicated release commit on the agreed long-lived branch. The current
   release workflow accepts only a tagged commit reachable from `develop` or
   `master`. A commit that exists solely on a temporary integration branch does
   not meet that gate until it is merged.
2. Update `package.json` and `electron/package.json` to the same semantic
   version. Rename `CHANGELOG.md`'s `Unreleased` section to that version and
   date, then add a fresh `Unreleased` section. The changelog describes user
   impact; ordinary commits do not change versions.
3. Select and run the necessary local checks before review. The release verify
   job is a useful final gate, but it is not the complete branch CI suite.
4. When tagging is authorized, use an exact stable tag such as `v1.2.3`. A tag
   push starts this workflow only when it matches that stable-tag glob. The
   manual dispatch has a tag input but no separate format or annotated-tag
   guard; checkout, ancestry, and manifest-version verification still decide
   whether it can package the selected ref.

The release verifier checks ancestry and those two manifest versions. Ancestry
shows that the commit is contained in `develop` or `master`; it does not by
itself prove that a pull request was reviewed or every required check passed.

### What the release verifier runs

The verifier runs lint, Stylelint, format checking, `pnpm test`, a production
web build, and Electron typecheck and unit tests. It does **not** run the
workspace-wide typecheck, Storybook, production-renderer, browser E2E, Android
or iOS E2E, or launched Electron E2E. Select extra evidence according to the
change before the tag is created, following [testing](../../apps/docs-developers/src/content/docs/testing/testing-strategy.md).

## Package and review the draft

After verification, the package matrix builds the desktop shell with publishing
disabled. It uploads these artifacts for 30 days:

| Host    | Current artifacts                                                                 | Distribution boundary                                                                                         |
| ------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Linux   | AppImage and `.deb`                                                               | The workflow packages them; it does not publish them to a download service.                                   |
| macOS   | `.dmg` and `.zip`, using the current `macos-latest` runner's default architecture | Signing and notarization depend on configured credentials. Verify the archive architecture before publishing. |
| Windows | NSIS `.exe`                                                                       | The workflow packages the installer; distribution remains a maintainer action.                                |

The final workflow job creates or updates a **draft** GitHub release. A partial
package matrix can still produce a draft containing the successful platform
artifacts and a partial-release warning. Inspect each available artifact and
the failed platform before publishing the draft. The workflow does not publish
the release for you, generate Web ZIPs, push container images, update an
auto-updater feed, upload to mobile stores, or finalize a public download.

> [!WARNING]
> Draft publication is an external action. Confirm authorization, the release
> notes, artifact completeness, signing status, and the intended audience
> before changing a draft to published.

### Signing and notarization

The package jobs use the GitHub `release` environment. Its presence in YAML
does not prove that required reviewers or environment protections are configured;
maintainers must check the repository settings before relying on them.

The workflow recognizes these secret names only:

- macOS signing: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`
- Windows signing: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`
- macOS Apple ID notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`

Without the applicable credentials, packaging can produce unsigned artifacts.
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

## Recover a release run

| Situation                                                                         | Recovery                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tag is not reachable from `develop` or `master`, or does not match both manifests | Correct the release commit through the normal review path, then create an authorized new matching tag. Do not retarget an existing tag.                                                                                                                    |
| A platform package fails but other packages succeed                               | Inspect the failed matrix log and the draft's partial warning. Rerun the same tag only after a transient runner, credential, or service fix; a draft's assets are replaced with `--clobber`. A source or manifest fix needs a new reviewed commit and tag. |
| Every package fails                                                               | For a transient runner, credential, or service failure, rerun the existing tag. For a source or manifest failure, make a new reviewed release commit and matching tag. No usable draft asset exists until a platform succeeds.                             |
| A draft-release upload fails                                                      | Use the retained package artifacts and rerun the workflow on the existing tag after diagnosing the failure.                                                                                                                                                |
| The release is already published                                                  | The workflow refuses to replace its assets. Prepare a new version and repeat the authorized release process.                                                                                                                                               |

Release runs intentionally do not cancel each other: an incomplete draft is
worse than a slower package run. A manual dispatch accepts an existing tag for
this recovery path; it is not a way to bypass the version or ancestry checks.
It rebuilds the tagged source, so a source or manifest correction needs a new
reviewed release commit and authorized matching tag.

Fresh builds include generated build information, so packages from the same
commit are not guaranteed to be byte-identical. Compare the release workflow's
inputs, artifact names, signatures, and intended version rather than claiming a
re-run is reproducible by hash alone.

## Renovate and the trigger it silently depends on

Renovate runs daily at 00:00 UTC and can be manually dispatched with a dry-run
and log-level choice. It reads [`.github/renovate.json`](../../.github/renovate.json)
and authenticates with the `RENOVATE_APP_CLIENT_ID` repository variable and
`RENOVATE_APP_PRIVATE_KEY` secret. Those names identify setup inputs only; never
copy their values into a ticket or log.

The workflow uses a GitHub App token instead of the default workflow token so
the update pull requests can start CI. Its health check requires a completed
repository log and, outside dry runs, an open Dependency Dashboard. For a
failure, start with the `renovate-log` artifact and the workflow's failed health
check rather than assuming a zero exit status means an update was considered.

### Apply the update policy

The committed [Renovate policy](../../.github/renovate.json) applies a
three-day minimum release age before its exceptions. Use this table when
reviewing an update branch or diagnosing why it did not merge.

| Update                        | Current behavior                                                                                                                                                                        | Maintainer action                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary non-patch dependency | Waits for Dependency Dashboard approval and opens a pull request.                                                                                                                       | Approve the dashboard entry, then review CI.                                                                                     |
| Patch dependency              | After the three-day age, Renovate uses branch automerge and rebases behind `develop`; it waits for CI on `renovate/patch-*`. A failed or 24-hour-pending branch becomes a pull request. | Keep the narrow `ci.yml` push trigger for `renovate/patch-**`; without it, patch automerge silently falls back to pull requests. |
| Security advisory             | Bypasses the age and dashboard gate, keeps a pull request, and can automerge after CI.                                                                                                  | Review the advisory and its labeled pull request; it intentionally does not use the patch-branch path.                           |
| GitHub Actions digest         | Stays behind dashboard approval and does not patch-automerge.                                                                                                                           | Review the changed pinned action digest before approval.                                                                         |
| Native platform dependency    | Stays behind dashboard approval.                                                                                                                                                        | Use the evidence described in the developer native platform guides before approval.                                              |
| TypeScript                    | Moves root and `electron/` manifests together in the `typescript` group, pinned below `6.1.0` for Angular 22's compiler window.                                                         | Widen that bound deliberately with an Angular upgrade; do not split the Electron version.                                        |

## Source of truth

The executable contracts are [`ci.yml`](../../.github/workflows/ci.yml),
[`docs-pages.yml`](../../.github/workflows/docs-pages.yml),
[`release.yml`](../../.github/workflows/release.yml),
[`renovate.yml`](../../.github/workflows/renovate.yml),
[`electron-builder.yml`](../../electron/electron-builder.yml), and the
[notarization hook](../../electron/build/notarize.cjs). Keep this guide aligned
with those files when a trigger, job, artifact, or credential name changes.
