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
| [`renovate.yml`](../../.github/workflows/renovate.yml)               | Daily at 00:00 UTC or a manual dispatch                                    | Dependency update maintenance through a GitHub App token                                                                                                        |
| [`release-stable.yml`](../../.github/workflows/release-stable.yml)   | A manual dispatch with `from` and `dry_run` inputs                         | Creates `release/X.Y.x` at a published prerelease and opens its stable release PR, through a GitHub App token                                                   |
| [`backport.yml`](../../.github/workflows/backport.yml)               | A merged `main` pull request is closed or labeled `backport release/X.Y.x` | Opens a PR that cherry-picks the fix onto each labeled release branch, through a GitHub App token                                                               |
| [`land-back-merge.yml`](../../.github/workflows/land-back-merge.yml) | `CI` completes on a `back-merge/**` branch of this repository              | Pushes the back-merge commit to `main` as a fast-forward, through a GitHub App token                                                                            |

The branch workflow accepts pushes to `main`, `release/**`, and
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

The classifier emits its reason and expected jobs. Wiring an aggregate required-result
status into branch rules belongs to the later protection slice
of [#462](https://github.com/quwisky/trinity-matrix-client/issues/462).

### Configure GitHub Pages

In repository Settings → Pages, set the publishing source to **GitHub Actions**.
Protect the `github-pages` environment so only the `main` branch can deploy.
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

| Job                     | Checks                                                                                                                                                          | First recovery step                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality`               | `pnpm lint`, `pnpm stylelint`, and `pnpm format:check`                                                                                                          | Fix the reported rule or formatting issue. Stylelint is separate from lint.                                                                                                                                                 |
| `test`                  | Workspace-wide typecheck, then `pnpm test`                                                                                                                      | Fix the type or unit failure; a passing Vitest run does not replace the typecheck.                                                                                                                                          |
| `renderer`              | One verified production web renderer build, recorded as a SHA/configuration/file manifest artifact                                                              | Inspect the renderer workflow's build, manifest, or upload step. Downstream hosts must consume this artifact.                                                                                                               |
| `desktop`               | Electron install, compile, typecheck, unit tests, and launched-shell E2E using the verified renderer                                                            | Use the [desktop guide](../../apps/docs-developers/src/content/docs/platforms/electron.md) to reproduce the matching shell or packaging step.                                                                               |
| `e2e`                   | Component Storybook, production renderer, styling, disposable-homeserver (Tuwunel) browser journeys, then QR verification                                       | Read the Playwright report and reproduce the smallest owned journey. The homeserver-backed flows use a fixed disposable stack, so run them sequentially.                                                                    |
| `mobile-e2e`            | WebdriverIO and Appium suite against the installed Capacitor app on an API 36 emulator, with identifiers scrubbed before upload                                 | Reproduce with `pnpm e2e:mobile`; check the uploaded `mobile.android` artifact for the WebView and chromedriver versions line.                                                                                              |
| `ios-native-build`      | Unsigned iOS Simulator host compile on `macos-26`, using the verified renderer and checking only Cordova extras                                                 | Inspect the retained Xcode log and result bundle; this is a compile gate, not installed-device evidence.                                                                                                                    |
| `scheduled-e2e`         | Chromium, Firefox, and WebKit scheduled suite                                                                                                                   | This weekly Sunday 03:23 UTC job is separate from pull-request jobs; diagnose its browser-specific artifact and environment.                                                                                                |
| `E2E (Synapse nightly)` | Separate `e2e-synapse-nightly.yml` workflow: browser, Electron full and protocol suites with `TRINITY_E2E_HOMESERVER=synapse`, daily at 02:47 UTC and on demand | Reproduce locally with the same variable, for example `TRINITY_E2E_HOMESERVER=synapse pnpm e2e:browser`. A failure that Tuwunel does not show is a server difference: branch the expectation on `homeserverSession().kind`. |

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
without registry credentials.
See [container validation](../../apps/docs-developers/src/content/docs/platforms/web-and-pwa.md) for commands,
Docker/browser prerequisites, and the native architecture limit. Trinity's existing root and
Electron package licenses remain MIT, with matching OCI metadata and preserved third-party
notices. Releases publish it: `release.yml`'s `package-web` job attaches `Trinity-Web-<version>.zip`
(the verified renderer, `LICENSE` and its web-bundle manifest) to the draft, and
[`container.yml`](../../.github/workflows/container.yml) runs when the release is published. It
verifies that zip against the tag commit, runs `trinity-web-container:smoke`, then pushes
`linux/amd64` and `linux/arm64` to `ghcr.io/quwisky/trinity-web` with `X.Y.Z`, `X.Y` and `latest`
(stable) or `X.Y.Z-next.N` and `next` (prerelease). Moving tags only follow the newest release on
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
tags the squash commit and creates a **draft** GitHub release. The same workflow run
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
2. Run it again with `dry_run` disabled. It pushes `release/X.Y.x` as the prerelease's
   commit plus one commit, `chore(release): release vX.Y.Z from this branch`, that sets
   `"release-as": "X.Y.Z"` for the root package in `release-please-config.json`. That push
   runs `release.yml` on the branch, whose release-please run opens the stable release PR
   with version `X.Y.Z`, so stable ships exactly the tested code. Without the pin, the
   stable config's `always-bump-patch` would propose a patch of the last stable release;
   every later push to the branch before the release (a fix merged first, say) keeps the
   PR at `X.Y.Z` because the pin stays in the config.
3. Review the stable release PR (version and `CHANGELOG.md` entry) and merge it. That is
   the last manual step: the tag, draft release and packages follow, and the `publish`
   job publishes the release once every package is attached (see
   [Automatic publishing](#automatic-publishing)).
4. Once `vX.Y.Z` is tagged, the `Open the back-merge PR` job pushes
   `chore(release): drop the one-time release-as after vX.Y.Z` to `release/X.Y.x`, so later
   fixes release as patches, then opens the back-merge PR. Its merge commit lands on `main`
   by a direct push once CI passes on it; step in only for conflicts (see
   [Back-merge conflicts](#back-merge-conflicts)).

The same run creates the label `backport release/X.Y.x` for the new line.

Prerequisites for a cut:

- The prerelease must be cut after the release-branch workflows landed on `main` (the
  workflow refuses older ones), and its minor line must not have a release branch yet. In
  practice the first cut is a `0.2.0-next.N` prerelease after a `feat`; `0.1.x` fixes go
  through `release/0.1.x` (see [Migrating from develop](#migrating-from-develop)). A dry run
  before such a prerelease exists is expected to refuse.
- Merge the previous line's back-merge PR first. The new branch's changelog starts from
  the last stable tag, which release-please finds only when that tag is in the branch's
  history.

The workflow refuses, and creates nothing, when `from` is not a published prerelease on
`main`'s history, when `release/X.Y.x` already exists (land fixes on it; its next stable
release is a patch release), or when a `vX.Y.Z` tag exists. It also refuses a prerelease
whose commit predates `release-stable.yml`, because a release branch inherits the
workflows of the commit it is cut from: cut a new prerelease from `main` first.

It pushes with the release App's installation token, not `GITHUB_TOKEN`: pushes made with
`GITHUB_TOKEN` trigger no workflows, so `release.yml` would never run on the new branch.
The release App is a GitHub App (for example "Trinity Release") installed only on this
repository with Contents, Pull requests and Issues: read & write (labels and pull request
comments use the issues API). Its
`RELEASE_APP_CLIENT_ID` variable and `RELEASE_APP_PRIVATE_KEY` secret live in the
`release-app` environment, whose deployment branch policy allows `main` and `release/**`;
the jobs that mint the token (`back-merge` and `publish` in `release.yml`, `cut` in
`release-stable.yml`, `backport.yml` and `land-back-merge.yml`) declare `environment: release-app`. Give
`release-app` no required reviewers: they would stall every cut, publish, back-merge and
backport. Reviewers belong on `release`, where they gate packaging only. The release App, not
Renovate, is the only bypass actor for `release/**` in the ruleset, and it is a bypass actor
on `main`'s ruleset so it can push back-merge commits. Renovate keeps its
own App and credentials.

Pushing the branch is the workflow's last step; a failure before it creates nothing, so
rerun it. Once the branch exists, rerunning is refused, and the branch already carries the
`release-as` commit. If no stable release PR appears on it, read the `Release PR and tag`
job of the `release.yml` run for that push and re-run it. If that run is gone, merge any
pull request into `release/X.Y.x` (an empty commit is enough) to trigger a new one. Never
force-push.

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
`release/X.Y.x` directly; the back-merge then carries it to `main`.

### Backports

`backport.yml` runs on `pull_request_target` for merged pull requests into `main` that carry
one or more `backport release/X.Y.x` labels. It never checks out the pull request's code: it
checks out `main` and cherry-picks the merged commit (with `-x`) onto a branch
`backport/<pr>-release-X.Y.x` cut from the release branch, then opens a pull request titled
`<original title> (backport to release/X.Y.x)`. It mints the release App token in the
`release-app` environment. Adding a label to an already merged pull request backports to
that line only; merging backports to every labelled line. [`scripts/backport.mjs`](../../scripts/backport.mjs) does the work.

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

### Back-merge conflicts

After a stable tag is created on a `release/**` branch, the `Open the back-merge PR` job in
`release.yml` runs [`scripts/back-merge.mjs`](../../scripts/back-merge.mjs). It merges the
tag into a new `back-merge/vX.Y.Z` branch from `main` and opens a pull request titled
`chore: back-merge vX.Y.Z into main`; the body lists the files it resolved. The merge
also removes the release branch's one-time `release-as` from `release-please-config.json`,
so `main` never carries it. Rerunning updates an existing PR, rebuilding the merge from
current `main` (a lease-guarded push of the bot's own branch), and does nothing when `main`
already contains the tag. The job does not affect the release itself.

`main` allows only squash merges, so never merge the PR with the button: a squash would
drop the tag from `main`'s history. Instead the PR lands by a direct push after CI passes.
Whenever `CI` completes on a `back-merge/**` branch of this repository, whatever its
conclusion, [`land-back-merge.yml`](../../.github/workflows/land-back-merge.yml) runs
[`scripts/land-back-merge.mjs`](../../scripts/land-back-merge.mjs) with the release App
token, which pushes the branch's head to `main` as a fast-forward, never forced. GitHub then
marks the PR merged. The script refuses, and pushes nothing, unless:

- the branch is still at the commit that CI run tested;
- the head has exactly two parents: the current `main` first and the `vX.Y.Z` tag named by
  the branch second. Commits on top of the merge, a merge of anything but the tag, or an
  octopus merge are refused. If `main` has moved, re-run the `Open the back-merge PR` job;
  it rebuilds the merge on current `main`, and the new CI run lands it;
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

It resolves conflicts in only these files, hunk by hunk with `git merge-file`: a
conflicting hunk takes the side below, and every non-conflicting edit from either side is
kept. A file added on both lines has no common ancestor, so it takes the whole side below;
the PR body flags it for review.

| Path                                                                                              | Resolution                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`, `.release-please-manifest.json`, `apps/docs-users/release.json`, user guide pages | The release branch's side                                                                                                   |
| `package.json`, `electron/package.json`                                                           | `main`'s side                                                                                                               |
| `.release-please-manifest.next.json`                                                              | The higher version by semver precedence (`0.1.1` beats `0.1.1-next.3`), so `main` continues at the next patch's prereleases |

The merged `package.json` and `electron/package.json` always keep `main`'s `version`, even when
they merge without a conflict. Any other conflicted path fails the job and lists the paths, as
does a file deleted on one line and changed on the other. A conflict in
`release-please-config.json` (for example `main` edited near `packages["."]` while the release
branch carried the one-time `release-as` pin) takes the same manual path. Resolve it by hand:

```bash
git fetch origin
git switch -c back-merge/vX.Y.Z origin/main
git merge --no-ff vX.Y.Z
# resolve the conflicts and remove any "release-as" from release-please-config.json, then
git add -A && git commit --no-edit
git push -u origin back-merge/vX.Y.Z
gh pr create --base main --head back-merge/vX.Y.Z \
  --title "chore: back-merge vX.Y.Z into main" \
  --body "Merges release/X.Y.x at vX.Y.Z back into main; conflicts resolved by hand."
```

CI runs on the PR and `land-back-merge.yml` lands it when it passes, as above. If that run
refused or is gone, re-run the `Land back-merge` workflow once CI is green, or, as a bypass
actor on `main`'s ruleset, land it yourself from an up-to-date clone with Node 24 or newer:

```bash
node scripts/land-back-merge.mjs --branch back-merge/vX.Y.Z   # or --pr N
```

Never merge it with the button and never force-push.

The job first drops the one-time `release-as` from the release branch with a plain push. If a
fix landed on the branch at that moment and the push was rejected, rerun the `Open the
back-merge PR` job; it rebases onto the branch, sees whether the pin is still there, and goes on.

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
   [Back-merge conflicts](#back-merge-conflicts)).

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
   `release` environment, which gates packaging in `release.yml`, must allow `main` and
   `release/**`; it may have required reviewers, which gate packaging only.
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
dispatch `release.yml` with `tag: v0.1.0` to build its draft. In the other order,
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

After verification, the package matrix builds the desktop shell with publishing
disabled. It uploads these artifacts for 30 days:

| Host    | Current artifacts                                                             | Distribution boundary                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux   | AppImage and `.deb`                                                           | The workflow packages them; it does not publish them to a download service.                                                                                              |
| macOS   | `.dmg` and `.zip`, using the current `macos-26` runner's default architecture | Signing and notarization depend on configured credentials. Verify the archive architecture before merging the release PR; `publish` only checks that assets are present. |
| Windows | NSIS `.exe`                                                                   | The workflow packages the installer; distribution remains a maintainer action.                                                                                           |
| Web     | `Trinity-Web-<version>.zip` from the `package-web` job                        | Publishing the release runs `container.yml`, which pushes the image built from this zip to GHCR.                                                                         |

The `draft-release` job creates or updates a **draft** GitHub release, and the `publish`
job then publishes it when every expected asset is attached (see
[Automatic publishing](#automatic-publishing)). A partial package matrix produces a draft
containing the successful platform artifacts and a partial-release warning, and the draft
stays a draft. Inspect each available artifact and the failed platform, fix the cause and
re-package the tag. The workflow does not update an auto-updater feed, upload to mobile
stores, or check signing status for you.

> [!WARNING]
> Merging a release PR now publishes the release without a further confirmation. Confirm
> authorization, the release notes and signing status before merging it.

### Signing and notarization

The package jobs use the GitHub `release` environment, which holds the signing secrets.
Its presence in YAML does not prove that required reviewers or environment protections
are configured; maintainers must check the repository settings before relying on them.
Reviewers on `release` gate packaging only: the release App jobs run in `release-app`.

The workflow recognizes these secret names only:

- macOS signing: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`
- Windows signing: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`
- macOS Apple ID notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`

Without the applicable credentials, packaging can produce unsigned artifacts.

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
Apple Silicon only and require macOS 13; each conflicts with the other because both
install `Trinity.app`.

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
   secrets `MAC_CSC_LINK` (base64 of the `.p12`), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. `release.yml` fails the macOS
   build when only some of them are set.
2. Create the public repository `quwisky/homebrew-trinity` **with an initial commit**
   (a README is enough); checkout and push fail on an empty repository.
3. Create the environment `homebrew` in this repository. Under deployment branches
   and tags, allow only `main`, `release/**` and tags matching `v*`.
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

## Recover a release run

| Situation                                                                                  | Recovery                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tag is not reachable from `main` or a `release/*` branch, or does not match both manifests | Fix the cause through a normal pull request; release-please then proposes a new version. Do not retarget or reuse an existing tag.                                                                                                                                                                   |
| A platform package fails but other packages succeed                                        | Inspect the failed matrix log and the `publish` job's warning, which names the missing assets. After a transient runner, credential, or service fix, dispatch `release.yml` with the same tag; `--clobber` replaces the draft's assets and `publish` completes it. A source fix needs a new release. |
| Every package fails                                                                        | For a transient failure, dispatch the same tag again. For a source or manifest failure, fix it through a normal pull request and release the next version.                                                                                                                                           |
| Container run cancelled (a newer publish queued behind it)                                 | A third run queued in the `container` group cancels the pending one, so that release has no image. Dispatch the Container workflow with its tag once the queue is clear.                                                                                                                             |
| Container workflow: no `Trinity-Web-<version>.zip` asset                                   | `package-web` failed and the draft was published anyway. Set the release back to draft (`gh release edit <tag> --draft=true`) and dispatch `release.yml` with the tag; the `publish` job republishes it once complete, which runs `container.yml`.                                                   |
| A draft-release upload fails                                                               | Dispatch `release.yml` with the same tag after diagnosing the failure.                                                                                                                                                                                                                               |
| release-please fails or opens no release PR                                                | Read the `Release PR and tag` job log. Only `feat`, `fix`, `perf`, `revert` and breaking commits produce a release; `chore`, `ci`, `docs`, `test`, `build`, `refactor` and `style` alone do not.                                                                                                     |
| The release is already published                                                           | The workflow refuses to replace its assets. Release the next version instead.                                                                                                                                                                                                                        |

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

| Update                        | Current behavior                                                                                                                                                                     | Maintainer action                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary non-patch dependency | Waits for Dependency Dashboard approval and opens a pull request.                                                                                                                    | Approve the dashboard entry, then review CI.                                                                                     |
| Patch dependency              | After the three-day age, Renovate uses branch automerge and rebases behind `main`; it waits for CI on `renovate/patch-*`. A failed or 24-hour-pending branch becomes a pull request. | Keep the narrow `ci.yml` push trigger for `renovate/patch-**`; without it, patch automerge silently falls back to pull requests. |
| Security advisory             | Bypasses the age and dashboard gate, keeps a pull request, and can automerge after CI.                                                                                               | Review the advisory and its labeled pull request; it intentionally does not use the patch-branch path.                           |
| GitHub Actions digest         | Stays behind dashboard approval and does not patch-automerge.                                                                                                                        | Review the changed pinned action digest before approval.                                                                         |
| Native platform dependency    | Stays behind dashboard approval.                                                                                                                                                     | Use the evidence described in the developer native platform guides before approval.                                              |
| TypeScript                    | Moves root and `electron/` manifests together in the `typescript` group, pinned below `6.1.0` for Angular 22's compiler window.                                                      | Widen that bound deliberately with an Angular upgrade; do not split the Electron version.                                        |

## Source of truth

The executable contracts are [`ci.yml`](../../.github/workflows/ci.yml),
[`docs-pages.yml`](../../.github/workflows/docs-pages.yml),
[`release.yml`](../../.github/workflows/release.yml),
[`release-stable.yml`](../../.github/workflows/release-stable.yml),
[`renovate.yml`](../../.github/workflows/renovate.yml),
and [`electron-builder.yml`](../../electron/electron-builder.yml), which notarizes signed macOS
builds with electron-builder's built-in notarization. Keep this guide aligned
with those files when a trigger, job, artifact, or credential name changes.
