# CI and releases

This guide is for maintainers diagnosing automation and preparing a desktop
release. It describes the workflows that are committed today. It does not
authorize a release, a tag, a workflow dispatch, a settings change, or the use
of a signing credential; those are separate external actions.

For checkout, local commands, and choosing a change's validation, start with
the [contributor workflow](../contributing/index.md). For branch, review,
changelog, and publication rules, use the [conventions](../contributing/conventions.md#branches-and-publication).

## Know what ran

| Workflow                                               | Starts when                                                       | What it provides                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| [`ci.yml`](../../.github/workflows/ci.yml)             | A pull request, selected pushes, or its weekly schedule           | Branch checks and browser, desktop, and Android evidence       |
| [`release.yml`](../../.github/workflows/release.yml)   | A stable `vX.Y.Z` tag push, or a manual dispatch with a tag input | Tag verification, desktop packages, and a draft GitHub release |
| [`renovate.yml`](../../.github/workflows/renovate.yml) | Daily at 00:00 UTC or a manual dispatch                           | Dependency update maintenance through a GitHub App token       |

The branch workflow accepts pushes to `develop` and `master`, plus every pull
request, including documentation-only changes. Required checks must always report;
do not add workflow-level path filters that leave a pull request waiting forever.
A newer run for the same workflow and ref cancels an older run. Diagnose the newest
run rather than treating a cancelled predecessor as a product failure.

The protection policy for `develop` and `master` requires a pull request, passing
CI checks against the current base, and resolved review conversations. No second
person's approval is required. Force pushes and branch deletion are blocked, with
no administrator or bot bypass. GitHub settings hold the enforced rules; keep their
required check names synchronized with the job names in `ci.yml`. The scheduled-only
job is not a required pull-request check.

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

| Job             | Checks                                                                                                       | First recovery step                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality`       | `pnpm lint`, `pnpm stylelint`, and `pnpm format:check`                                                       | Fix the reported rule or formatting issue. Stylelint is separate from lint.                                                                           |
| `test`          | Workspace-wide typecheck, then `pnpm test`                                                                   | Fix the type or unit failure; a passing Vitest run does not replace the typecheck.                                                                    |
| `build`         | Production web build                                                                                         | Resolve the production/AOT failure.                                                                                                                   |
| `desktop`       | Electron install, compile, typecheck, unit tests, and launched-shell E2E                                     | Use the [desktop guide](../platforms/desktop.md) to reproduce the matching shell or packaging step.                                                   |
| `e2e`           | Component Storybook, production renderer, styling, disposable-Synapse browser journeys, then QR verification | Read the Playwright report and reproduce the smallest owned journey. The Synapse-backed flows use a fixed disposable stack, so run them sequentially. |
| `android-e2e`   | Four API 36 Pixel 6 WebView shards                                                                           | Use the [mobile guide](../platforms/mobile.md) and the Android-specific failure output; browser success does not prove this host.                     |
| `scheduled-e2e` | Chromium, Firefox, and WebKit scheduled suite                                                                | This weekly Sunday 03:23 UTC job is separate from pull-request jobs; diagnose its browser-specific artifact and environment.                          |

The browser, Android and scheduled jobs attempt report uploads with `always()`
and seven-day retention. Inspect any available artifacts before rerunning, but
do not assume all traces or raw output were captured: their paths are under hidden
`dist/.playwright/`, while the workflows do not enable `include-hidden-files` and
the [pinned upload action](https://github.com/actions/upload-artifact/blob/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/action.yml)
defaults it to false. Missing files only produce a warning. This report-preservation
gap is part of [pending CI work](https://github.com/quwisky/trinity-matrix-client/issues/462).
When an artifact is missing or incomplete, use the workflow step logs and reproduce
the owning check locally, retaining its ignored output. A failed Renovate run
separately attempts to upload the non-hidden `renovate-log.ndjson` for seven days.

For local commands and the distinction between unit, type, renderer, and real
host checks, see [testing](../contributing/testing.md) and
[commands](../contributing/commands.md). Do not turn a timeout or an unavailable
Docker, browser, emulator, or macOS host into a passing result; record the
unavailable prerequisite and the evidence that did run.

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
change before the tag is created, following [testing](../contributing/testing.md).

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
instructions](../platforms/desktop.md) when preparing those credentials; do not
put their values in issues, logs, or documentation.

Android and iOS retain independent `1.0` / build-code values and are not part
of the current release version gate. Their build and distribution requirements
belong to the [mobile guide](../platforms/mobile.md).

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

## Renovate and protected branches

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

| Update                        | Current behavior                                                                                                                | Maintainer action                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Ordinary non-patch dependency | Waits for Dependency Dashboard approval and opens a pull request.                                                               | Approve the dashboard entry, then review CI.                                                                  |
| Patch dependency              | After the three-day age, Renovate opens a pull request, rebases behind `develop`, and merges once CI passes.                    | Keep PR-based automerge; direct branch automerge cannot satisfy protection.                                   |
| Security advisory             | Bypasses the age and dashboard gate, keeps a pull request, and can automerge after CI.                                          | Review the advisory and its labeled pull request.                                                             |
| GitHub Actions digest         | Stays behind dashboard approval and does not patch-automerge.                                                                   | Review the changed pinned action digest before approval.                                                      |
| Native platform dependency    | Stays behind dashboard approval.                                                                                                | Use the native build/device evidence described in the [mobile guide](../platforms/mobile.md) before approval. |
| TypeScript                    | Moves root and `electron/` manifests together in the `typescript` group, pinned below `6.1.0` for Angular 22's compiler window. | Widen that bound deliberately with an Angular upgrade; do not split the Electron version.                     |

## Work that is not automated yet

This guide documents committed behavior. [Issue #462](https://github.com/quwisky/trinity-matrix-client/issues/462)
is open work toward further CI and release readiness; it is not evidence that a
release finalizer, release-please, Web ZIP, container publication, or store
delivery exists today. The weekly scheduled E2E workflow already exists, even
if older discussion of that issue predates it.

[Issue #464](https://github.com/quwisky/trinity-matrix-client/issues/464) is
also open work for signed Android Play internal-testing and iOS TestFlight
delivery. It does not make either mobile distribution path part of this release
workflow.

Use the host guides for current packaging constraints, and create or update an
explicit proposal before describing a new distribution target as supported.

## Source of truth

The executable contracts are [`ci.yml`](../../.github/workflows/ci.yml),
[`release.yml`](../../.github/workflows/release.yml),
[`renovate.yml`](../../.github/workflows/renovate.yml),
[`electron-builder.yml`](../../electron/electron-builder.yml), and the
[notarization hook](../../electron/build/notarize.cjs). Keep this guide aligned
with those files when a trigger, job, artifact, or credential name changes.
