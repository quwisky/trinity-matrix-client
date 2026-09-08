# CI and releases

This guide is for maintainers diagnosing automation and preparing a desktop
release. It describes the workflows that are committed today. It does not
authorize a release, a tag, a workflow dispatch, a settings change, or the use
of a signing credential; those are separate external actions.

For checkout, local commands, and choosing a change's validation, start with
the [contributor workflow](../contributing/index.md). For branch, review,
changelog, and publication rules, use the [conventions](../contributing/conventions.md#branches-and-publication).

## Know what ran

| Workflow                                                     | Starts when                                                              | What it provides                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [`ci.yml`](../../.github/workflows/ci.yml)                   | A pull request, selected pushes, or its weekly schedule                  | Branch checks and browser, desktop, and Android evidence                      |
| [`e2e-nightly.yml`](../../.github/workflows/e2e-nightly.yml) | Monday–Saturday at 03:23 UTC or manual dispatch during replacement proof | Canonical scheduled registry tier, aggregate diagnostics and timing summaries |
| [`release.yml`](../../.github/workflows/release.yml)         | A stable `vX.Y.Z` tag push, or a manual dispatch with a tag input        | Tag verification, desktop packages, and a draft GitHub release                |
| [`renovate.yml`](../../.github/workflows/renovate.yml)       | Daily at 00:00 UTC or a manual dispatch                                  | Dependency update maintenance through a GitHub App token                      |

The branch workflow accepts pushes to `develop`, `master`, and
`renovate/patch-**`; pull requests are its usual review path. A newer run for
the same workflow and ref cancels an older run. Diagnose the newest run rather
than treating a cancelled predecessor as a product failure.

Every pull request runs `classify`. Its event payload supplies explicit base and head
commits: PRs use a unique merge base, and pushes compare before/after commits.
Only Markdown under `docs/users/`, `docs/contributing/`, `docs/architecture/`,
`docs/platforms/`, plus `docs/index.md` and the named push-notification and
troubleshooting reference guides qualifies for `docs-gate`. That gate runs
formatting and the scripts source-contract suite. Unknown events, empty or
unavailable diffs, branch creation, ambiguous merge bases, and every other path
select the full code graph. Configuration, scripts, lockfiles, root documents,
`docs/maintaining/`, and `docs/reference/stack.md` therefore retain full validation.

The classifier emits its reason and expected jobs. The `CI / Required` job runs after
the independent checks and feeds their results to the tested required-result
evaluator. It rejects failed, cancelled, missing, or skipped expected jobs and missing
classifier data. Its master-source guard checks the event against fresh PR metadata;
the result summary still runs when source validation fails. `CI / Required` is the
literal check-run name returned by GitHub, not a workflow-name prefix inferred from
the UI. Installing this workflow and applying the
[protected-branch cutover](#enforce-branch-checks) are separate steps.

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

Setup summaries report the pinned cache action's actual output: an exact hit, a
non-exact/missed lookup, or unavailable evidence. A quick install is not proof of
a cache hit. Browser-download caching remains separate from pnpm and Gradle.
The phase summary uses the current workflow attempt's job/step timestamps;
missing timestamps and in-progress steps remain explicit. Overlapping job
durations are not added together as elapsed workflow time. A bounded timing API
failure is a visible reporting warning and cannot change the required result.

## The CI jobs

Open the newest workflow run, then start with the first failing step and its
log. Do not infer repository-wide merge rules from the workflow YAML: branch
protection and rulesets live in GitHub settings and may impose additional
requirements.

| Job                       | Checks                                                                                                          | First recovery step                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `quality`                 | `pnpm lint`, `pnpm stylelint`, and `pnpm format:check`                                                          | Fix the reported rule or formatting issue. Stylelint is separate from lint.                                                        |
| `unit-and-types`          | Workspace-wide typecheck, then `pnpm test`                                                                      | Fix the type or unit failure; a passing Vitest run does not replace the typecheck.                                                 |
| `renderer`                | One verified production web renderer build, recorded as a SHA/configuration/file manifest artifact              | Inspect the renderer workflow's build, manifest, or upload step. Downstream hosts must consume this artifact.                      |
| `component-storybook-e2e` | Component Storybook journeys                                                                                    | Inspect the component report and its Storybook build prerequisites.                                                                |
| `component-styling-e2e`   | Styling journeys against the development application                                                            | Inspect the styling report and the selected theme or viewport.                                                                     |
| `browser-synapse-e2e`     | Full canonical browser journeys with disposable Synapse                                                         | Reproduce the smallest owned journey through its Nx lifecycle target.                                                              |
| `qr-protocol-e2e`         | QR verification protocol journeys                                                                               | Inspect both clients' verification state and the protocol report.                                                                  |
| `production-renderer-e2e` | Production renderer journeys using the verified artifact                                                        | Inspect the manifest verification and production browser report.                                                                   |
| `web-container`           | Rootless container HTTP, image, and offline PWA checks using the verified renderer                              | Inspect the Docker host evidence and PWA report.                                                                                   |
| `desktop-e2e`             | Electron install, compile, typecheck, unit tests, and launched-shell E2E using the verified renderer            | Use the [desktop guide](../platforms/desktop.md) to reproduce the matching shell or packaging step.                                |
| `android-e2e`             | Four API 36 Pixel 6 WebView shards using the verified renderer                                                  | Use the [mobile guide](../platforms/mobile.md) and the Android-specific failure output; browser success does not prove this host.  |
| `ios-native-build`        | Unsigned iOS Simulator host compile on `macos-26`, using the verified renderer and checking only Cordova extras | Inspect the retained Xcode log and result bundle; this is a compile gate, not installed-device evidence.                           |
| `scheduled-e2e`           | Chromium, Firefox, and WebKit scheduled suite                                                                   | The canonical tier runs in the nightly/manual workflow; the Sunday CI owner remains temporarily until replacement proof completes. |

Code events run twelve code-job definitions, with Android expanding to four shards
for fifteen code executions. Only production consumers wait for `renderer`; one
browser suite failure does not suppress the other suites. The five browser jobs
call the bounded [`_e2e-suite.yml`](../../.github/workflows/_e2e-suite.yml) workflow.
Nx and the E2E registry retain command, preparation, timeout, and resource ownership.
The `CI / Required` aggregate is a separate non-matrix job and reads the matrix result
without relying on a shard's scalar output.

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

The browser prerequisites helper selects browser installation, any required development
or Storybook build, and optional Docker pre-pull from the suite registry. It runs
those prerequisites concurrently, retaining each exit code and labeled
logs under `dist/.ci/`. Browser/build failure is fatal; Docker pre-pull failure is
a warning because suite setup can pull again. Android waits for udev to settle
before checking KVM access. Its Playwright download cache is separate from Gradle.
A failed Renovate run separately uploads `renovate-log.ndjson` for seven days.

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

Desktop, Android, iOS, the Web container, and the production renderer journey download that artifact and
validate its coordinates, manifest digest, file contents, and expected checkout before
installing the payload into the canonical `www/` directory. The native wrappers allow
only their generated Cordova files alongside the manifest payload. A failed validation
does not replace `www/`. Production consumers do not prepare a development bundle.
Styling and canonical browser journeys intentionally use the development server;
Storybook keeps its separate component build.

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
host checks, see [testing](../contributing/testing.md) and
[commands](../contributing/commands.md). Do not turn a timeout or an unavailable
Docker, browser, emulator, or macOS host into a passing result; record the
unavailable prerequisite and the evidence that did run.

### iOS compiler diagnostics

The unsigned iOS job records the selected Xcode and SDK versions, build settings,
compiler log, execution status, and unique Xcode result bundle under `dist/ios-native/`.
Its managed compiler deadline leaves time to validate and upload evidence after an
ordinary compiler failure or timeout. Required missing or malformed diagnostics fail
the job; that validation failure does not suppress upload of the evidence that exists.
DerivedData is excluded from uploads. This gate proves compilation on `macos-26`;
it does not boot a simulator or use a signing environment.

## Container validation

The `trinity-web-container` host exposes `verify`, `build-prebuilt`, and `smoke`
Nx targets. The independent `web-container` CI job checks the shared production renderer manifest
before building the pinned rootless SWS image and proves its HTTP and offline PWA contract
without registry credentials.
See [container validation](../platforms/web.md#verify-the-container-host) for commands,
Docker/browser prerequisites, and the native architecture limit. Trinity's existing root and
Electron package licenses remain MIT, with matching OCI metadata and preserved third-party
notices. Container publication remains release work.

## Scheduled coverage and timing evidence

The dedicated [nightly workflow](../../.github/workflows/e2e-nightly.yml) invokes
`pnpm e2e:scheduled`, the existing registry-owned aggregate. The registry selects
the scheduled tier at execution time; the workflow does not maintain another
suite list. One invocation acquires the full resource union before children,
and the selected suites execute sequentially. Shared-port suites do not overlap.

After an ordinary completed suite failure, this aggregate runs the later intended
suites and retains an overall failure. Before continuing, it verifies a unique
completion record written after the inner Playwright process exits normally and
its invocation cleanup succeeds; an outer Nx exit code alone is insufficient.
A missing or malformed started-suite summary is a failure. Termination or unsafe execution/cleanup stops later work
with an explicit not-run reason. Partial aggregate JSON and Markdown retain
completed results and the failure; other aggregates retain their existing
fail-fast behavior. Managed command timeout leaves collection time before the
job deadline. Hard runner loss or cancellation cannot guarantee uploads.

Each suite records selected/executed test counts, attempts, retries, expected
and unexpected failures, skipped tests and final flaky outcomes. Flakiness comes
from the final Playwright test outcome; retry count alone is not a flaky-test
count. Older schema-1 reports remain readable, with absent measurements marked
unavailable. Suite rows and the aggregate Markdown appear in the job summary;
raw reports and process logs remain in the attempt-specific diagnostic artifact.
Renderer jobs continue to report their existing verified manifest identity.

### Finish the scheduled-workflow replacement

The first change deliberately schedules the new workflow Monday–Saturday at
03:23 UTC and preserves the existing Sunday 03:23 UTC job. These automatic dates
do not overlap; both use the same aggregate and its one resource owner. This is
a temporary replacement period, not completed nightly acceptance.

After the user merges the new workflow onto default branch `develop`, collect
one real manual run and a real scheduled event. Record event, ref, full checkout
SHA, run/attempt, selected tier, lock/cleanup evidence, terminal results and
retained artifacts. A manual dispatch does not prove the scheduler fired.
Demonstrate ordinary-failure continuation and managed-timeout diagnostics without
weakening the product suites or counting deliberate probes as performance samples.
Then make the reviewed follow-up remove `ci.yml`'s Sunday trigger/job and change
the new cron to every day. Leave that merge to the user and read back both final
workflow files plus an actual scheduled run. Keep #584 open until replacement
and measurement acceptance are complete.

### Measure the first ten representative code-PR runs

Use the first ten chronological public code-PR executions of the new #582 graph,
starting at its initial public rollout. Record the boundary revision and each
run's exact graph revision, PR, target branch, head/test-merge SHA, run ID and
initial attempt before drawing conclusions. Use one sample per run ID; reruns
are diagnostic follow-up. Retain older qualifying runs even when newer summary
fields were not yet available, reconstructing available timestamps from the API
and logs and labeling missing measurements.

Exclude docs-only, push, nightly/manual and deliberate probe runs, synthetic
trigger-only changes and runs demonstrably broken during initial environment
provisioning. Keep a chronological exclusion ledger with evidence. Cold cache,
queue time, slow hosts, ordinary failures and retries are not exclusions.
Keep superseded/cancelled runs as censored observations; their short duration is
not fast completion. Report their frequency separately from ten complete runs.

Measure user wait from workflow creation, including queue/dependency delay, and
also report execution-only phases. First actionable failure uses a failing
phase's timestamp; terminal step time is an upper bound when finer evidence is
unavailable. Green runs have no first-failure observation. Non-native completion
is the latest completed required quality, unit/type, renderer, browser, container
or Electron job. Exclude Android, iOS and the aggregate's wait on them. A failed
prerequisite with unexecuted dependent jobs does not prove full-graph latency;
report the available denominator instead of replacing that run silently.

Publish raw observations and nearest-rank p95, sorted value `ceil(0.95 × n)`.
For ten observations this is the maximum. Assess the five-minute first-failure
goal only across observed natural failures and the fifteen-minute non-native
p95 goal only with a sufficient complete denominator. Keep each Android shard's
distribution, slowest-shard completion and iOS compile distribution separate.
Derive provisional native targets from those observations with stated headroom;
do not pool forty correlated shard observations as forty independent PRs.
Verify one production renderer compilation and exact consumer identity for each
eligible complete graph. Missing data or a target miss stays visible; the goals
do not authorize reduced tests or new merge gates. Store raw collection and
calculation files under ignored output, and record the resulting evidence on #584.

## Enforce branch checks

The [protection child](https://github.com/quwisky/trinity-matrix-client/issues/583) owns
the live cutover and its dated API evidence. Complete source review and merge the CI
change through the normal user-owned merge process before applying settings. A stacked
PR's test-merge result cannot replace successful push CI at a protected branch tip.

### Query the exact CI evidence

`scripts/ci-check-trust.mjs` makes read-only GitHub API requests. It pins repository
`1283201912` (`quwisky/trinity-matrix-client`), CI workflow `318169767`
(`.github/workflows/ci.yml`), and check App `15368` (`github-actions`). It requires one
unambiguous matching push run and a successful `CI / Required` job/check in that run's
latest completed successful attempt. Conflicting runs, a changed attempt, a wrong
source/SHA or a missing aggregate reject the proof. An earlier failure permits a later
successful retry; an earlier success cannot conceal a failed or running latest attempt.

```bash
node scripts/ci-check-trust.mjs branch-tip --branch develop --sha FULL_SHA --out dist/ci-protection/develop-proof.json
node scripts/ci-check-trust.mjs branch-tip --branch master --sha FULL_SHA --out dist/ci-protection/master-proof.json
node scripts/ci-check-trust.mjs release --sha TAGGED_FULL_SHA --out dist/ci-protection/release-proof.json
```

Replace each placeholder with the full observed commit SHA. `branch-tip` re-reads the
selected ref before and after collection. `release` always checks a push on `master`
at the supplied historical commit; it does not resolve a branch or accept ancestry,
a PR check or a newer green commit. Release automation adopts this query in its owning
child; the current `release.yml` retains the ancestry gate documented below.

Master PRs accept a `develop` head only when both event and fresh API data identify
this same numeric repository and agree on the PR/head identity. The dedicated Release
Please exception defaults to disabled. Its release child must provision the numeric
App-to-bot binding before enabling it; a bot login or branch prefix is insufficient.
The master-only ruleset enforces merge commits because CI cannot determine which merge
method a maintainer will eventually select.

### Bootstrap and apply the reviewed policy

Use a maintainer credential with repository rule/administration access, branch-creation
access and read access to Actions, checks, contents and PRs. Keep administrative
credentials out of PR jobs. Save fresh API responses and reviewed JSON payloads under
ignored `dist/ci-protection/`; do not commit settings snapshots or an apply framework.

1. Read the repository, both branch refs, CI workflow identity, all active rulesets
   (including inherited rules), effective branch rules and outside-contributor policy.
   Run the exact-tip query on the merged `develop` SHA and inspect the emitted check
   name and source. Only an actual 404 proves that `master` is absent; a permission
   or network failure is not absence.
2. If `master` is absent, re-read `develop` and verify its unchanged tip immediately
   before creation. Prepare `create-master.json` with exactly
   `{"ref":"refs/heads/master","sha":"VERIFIED_DEVELOP_FULL_SHA"}`. Create it once
   with `gh api --method POST repos/quwisky/trinity-matrix-client/git/refs --input dist/ci-protection/create-master.json`
   using a credential that triggers push CI, then read it back. Never reset an existing
   branch or weaken basic PR/deletion/force-push rules to make bootstrap succeed.
3. Wait for the designated workflow's real push run on `master`. Verify both branches
   independently at their current tips using the commands above. PR/dispatch evidence
   and the ref-creation response do not substitute for either push result.
4. Prepare the following payloads from fresh rule/settings responses and inspect their
   before/after diff. Preserve every unrelated writable field. Stop and reconcile an
   unexpected required context, bypass, moved ref or changed baseline before applying.

| Payload                  | Required policy                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `master-merge-rule.json` | One active branch ruleset targeting only `refs/heads/master`, with no bypass. Copy the baseline PR parameters and set `allowed_merge_methods` to `["merge"]`. Reuse its recorded ID on resumption instead of creating duplicates.                                                                                                             |
| `required-ruleset.json`  | Update existing active ruleset `22388906`, preserving its `develop`/`master` targets, PR requirement, resolved conversations, zero approvals, no deletion and no force push. Set `bypass_actors` to `[]`. The sole required status is `{"context":"CI / Required","integration_id":15368}` with `strict_required_status_checks_policy: true`. |
| `fork-approval.json`     | `{"approval_policy":"all_external_contributors"}`                                                                                                                                                                                                                                                                                             |
| `repository.json`        | `{"allow_auto_merge":true}`; preserve the other repository merge settings.                                                                                                                                                                                                                                                                    |

5. Repeat both exact-tip proofs and compare fresh refs/rules to the reviewed inputs.
   Apply the master-only rule and contributor policy first:

```bash
gh api --method POST repos/quwisky/trinity-matrix-client/rulesets --input dist/ci-protection/master-merge-rule.json
gh api --method PUT repos/quwisky/trinity-matrix-client/actions/permissions/fork-pr-contributor-approval --input dist/ci-protection/fork-approval.json
```

Record and read back the new master-only ruleset ID. Repeat both exact-tip queries and
compare freshly fetched refs and the existing ruleset to the reviewed baseline immediately
before requiring the status. Refresh the reviewed payload if the baseline changed.
Enable auto-merge last:

```bash
gh api --method PUT repos/quwisky/trinity-matrix-client/rulesets/22388906 --input dist/ci-protection/required-ruleset.json
gh api --method PATCH repos/quwisky/trinity-matrix-client --input dist/ci-protection/repository.json
```

Read back the repository, every active ruleset and both effective branch policies:

```bash
gh api repos/quwisky/trinity-matrix-client
gh api repos/quwisky/trinity-matrix-client/git/ref/heads/develop
gh api repos/quwisky/trinity-matrix-client/git/ref/heads/master
gh api repos/quwisky/trinity-matrix-client/actions/workflows/ci.yml
gh api --paginate repos/quwisky/trinity-matrix-client/rulesets
gh api repos/quwisky/trinity-matrix-client/rulesets/22388906
gh api repos/quwisky/trinity-matrix-client/rules/branches/develop
gh api repos/quwisky/trinity-matrix-client/rules/branches/master
gh api repos/quwisky/trinity-matrix-client/actions/permissions/fork-pr-contributor-approval
```

Fetch each other active ruleset by its observed ID as well. Confirm the single required
context/App, strict current-base policy, no active bypass, zero approvals, resolved
conversations, deletion/force-push restrictions, master merge-only rule, auto-merge and
all-outside-contributor approval. Keep disabled unrelated rulesets disabled. A classic
branch-protection 404 does not override effective ruleset protection. Recheck branch tips
after settings changes: GitHub has no atomic transaction covering refs and rule updates.
Record partial failures and retain installed protection; never restore a bypass to
complete the sequence. Observe current-base blocking and actual contributor approval
when those real events occur, distinguishing settings read-back from behavioral proof.

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
| Native platform dependency    | Stays behind dashboard approval.                                                                                                                                                        | Use the native build/device evidence described in the [mobile guide](../platforms/mobile.md) before approval.                    |
| TypeScript                    | Moves root and `electron/` manifests together in the `typescript` group, pinned below `6.1.0` for Angular 22's compiler window.                                                         | Widen that bound deliberately with an Angular upgrade; do not split the Electron version.                                        |

## Work that is not automated yet

This guide documents committed behavior. [Issue #462](https://github.com/quwisky/trinity-matrix-client/issues/462)
is open work toward further CI and release readiness; it is not evidence that a
release finalizer, release-please, Web ZIP, container publication, or store
delivery exists today. Scheduled E2E is transitioning to the dedicated nightly/manual
workflow; [replacement proof and timing evidence](#scheduled-coverage-and-timing-evidence)
remain separate acceptance work.

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
