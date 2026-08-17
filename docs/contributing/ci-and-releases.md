# CI and releases

Two GitHub Actions workflows do the work that matters, plus one that keeps
dependencies moving.

| Workflow                                                                                                       | Fires on                                                                   | Job of                                                           |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`ci.yml`](https://github.com/quwisky/trinity-matrix-client/blob/develop/.github/workflows/ci.yml)             | Every pull request, and pushes to `develop`, `master`, `renovate/patch-**` | Five parallel jobs that gate a branch                            |
| [`release.yml`](https://github.com/quwisky/trinity-matrix-client/blob/develop/.github/workflows/release.yml)   | A `v1.2.3` tag push, or a manual dispatch                                  | Verifying the tag, packaging three platforms, drafting a release |
| [`renovate.yml`](https://github.com/quwisky/trinity-matrix-client/blob/develop/.github/workflows/renovate.yml) | A daily cron, or a manual dispatch                                         | Running Renovate under a short-lived GitHub App token            |

`ci.yml` sets `concurrency` on the workflow plus ref with `cancel-in-progress: true`,
so a newer push supersedes a run in flight, and grants only `contents: read`.

## The five CI jobs

Each job runs on its own runner and repeats the shared setup. They are independent:
one failing does not stop the others.

| Job       | Runs                                                                                              | Exists to catch                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quality` | `pnpm lint`, `pnpm stylelint`, `pnpm format:check`                                                | Lint rules, module-boundary violations, SCSS violations, and formatting drift                                                                                            |
| `test`    | `pnpm test`                                                                                       | Unit regressions across the 25 projects with a `test` target                                                                                                             |
| `build`   | `pnpm build`                                                                                      | AOT-only failures. The production build runs the Angular compiler, which rejects template type errors Vitest never sees, because Vitest transpiles without type checking |
| `desktop` | Electron install, `ensure:binary`, `compile`, `test`, then `xvfb-run -a pnpm electron:e2e`        | Anything in the desktop shell, up to and including launching the real binary                                                                                             |
| `e2e`     | Browser install, Docker pre-pull and a dev build in parallel, then `pnpm exec nx e2e trinity-e2e` | Broken user journeys against a real homeserver                                                                                                                           |

`stylelint` is a separate step because it is genuinely not part of `pnpm lint` in
this repository. Running `pnpm lint` alone will not catch a SCSS violation, locally
or in CI.

### Why the desktop job pays for a second production build

`xvfb-run -a pnpm electron:e2e` expands to `electron:build` first, which begins with
a full production `nx build trinity`. That duplicates the `build` job's work on a
separate runner, and since there is no remote Nx cache it cannot be reused.

This is an accepted cost rather than an oversight. The job comment records why the
binary download used to be skipped — "nothing here launches Electron" — which was
true and was the problem: a two-major Chromium bump had no gate at all, and the e2e
suite that does launch Electron had silently rotted, still toggling a CSS class
renamed months earlier and running a "crypto WASM loads" test that loaded no WASM.
This is now the only gate in the repository on the custom `trinity://` scheme, WASM
stream instantiation, the sandbox posture and safeStorage.

`ensure:binary` runs as its own step ahead of the e2e run so that a wedged
`@electron/get` download fails as itself, rather than surfacing later as a Playwright
launch timeout.

### The e2e job's parallel prepare step

Playwright orders its `webServer` (the dev build) before `globalSetup` (the Synapse
boot), and the browser install is a separate step ahead of both, so three independent
legs would otherwise run strictly in sequence. The `Prepare e2e prerequisites` step
backgrounds the browser install and the Docker image pull, runs the dev build in the
foreground, and then waits on **each pid separately**:

```bash
wait "$pw"; pw_rc=$?
wait "$dk"; dk_rc=$?
```

`wait $pw $dk` would return only the last pid's status, so a failed browser install
would be swallowed and the job would burn its whole budget on repeated
`Executable doesn't exist` attempts. The browser install is fatal; the image pull is
only a warning, because `compose up` in global setup pulls anything missing and a
registry rate-limit blip should stay self-healing.

The pre-build is not duplicated work: the suite's own `webServer` replays it from the
in-job Nx cache, measured at 0.97s on the second invocation.

The job carries `timeout-minutes: 60`. The comment is explicit that this is derived
rather than measured, extrapolated from an 8 to 11 minute critical path recorded when
the suite was 104 specs. Measure a real full-size run before lowering it.

### The artifact upload uses always, not failure

```yaml
- uses: actions/upload-artifact@…
  if: always()
```

`timeout-minutes` **cancels** a job rather than failing it, and `if: failure()` does
not fire on a cancellation — so the run most in need of a trace would upload nothing.
The upload covers the Playwright report, the test output and the blob report, with
`overwrite: true` because artifacts are immutable per run and a re-run of a failed job
otherwise dies with `409 Conflict`. The blob report is included because the Nx
Playwright preset enables that reporter whenever `CI` is set.

## Caching and the shared setup action

Every job in both workflows uses
[`.github/actions/setup`](https://github.com/quwisky/trinity-matrix-client/blob/develop/.github/actions/setup/action.yml).
Its ordering is load-bearing in two ways.

`pnpm/action-setup` must come **before** `actions/setup-node`, because the latter's
`cache: pnpm` resolves the store path by shelling out to pnpm, which is not on the
runner yet. And it must **not** be given a `version:` input: the version comes from
`package.json`'s `packageManager` field, and passing both is an error rather than an
override.

`setup-node` pins Node 24 and sets `cache-dependency-path` to **both**
`pnpm-lock.yaml` and `electron/pnpm-lock.yaml`. The two projects share one global
store, so the desktop packages land in the cache either way — but without the second
path the cache key ignores changes there, hits the primary key exactly, skips the
save, and re-downloads that delta forever.

Install is `pnpm install --frozen-lockfile`, which fails when the lockfile is out of
sync with `package.json`. A dependency edit committed without its lockfile change is
caught here rather than as mysterious version drift later.

| Cache                    | Key                                         | Where         |
| ------------------------ | ------------------------------------------- | ------------- |
| pnpm store               | Both lockfiles, via `setup-node`            | Every job     |
| `~/.cache/electron`      | `electron/pnpm-lock.yaml`                   | `desktop` job |
| `~/.cache/ms-playwright` | `pnpm-lock.yaml`, with a prefix restore-key | `e2e` job     |

There is deliberately **no** `actions/cache` step for Nx. Nx 23 keeps the
hash-to-result index in a SQLite database under `.nx/workspace-data`, not
`.nx/cache`, and that database is keyed by machine id — so a restored cache yields a
measured 0% hit rate while still paying the upload and the download. Caching both
directories was tried and is unsound for the same reason. The supported answer for
ephemeral runners is a remote cache, which this repository does not use.

!!! warning "Actions are pinned to commit SHAs, not tags"

    Every `uses:` in both workflows is a 40-character SHA with the version in a
    trailing comment. A tag is mutable, and retargeting one is how CVE-2025-30066
    reached roughly 23,000 repositories. This matters more here than in most repos:
    the setup action installs the pnpm binary that later runs electron-builder with
    signing certificates in its environment. Renovate keeps the digests current so
    the pins do not rot.

## Three invariant specs that guard what a green run cannot see

All three live in the `scripts` project and run as part of `pnpm test`, so they gate every
pull request and every release.

### The lint invariants spec

A linter upgrade that fails loudly is cheap. One that silently stops **applying** a
rule is not: the run stays green, fewer things are enforced, and nothing says so.
That is not hypothetical — ESLint 10 pulled `@eslint/config-array` 0.21 to 0.23,
which carries an upstream breaking `minimatch` 3 to 10 swap, a change to the very
glob engine that decides which config block a file gets. It happened to be inert; the
point is that a green lint was not evidence of that.

[`lint-invariants.spec.mjs`](https://github.com/quwisky/trinity-matrix-client/blob/develop/scripts/lint-invariants.spec.mjs)
resolves the real ESLint config for specific files with `calculateConfigForFile` and
asserts its **shape**:

- `libs/spartan/*` is exempt from exactly four generated-code rules and nothing else.
  It diffs the entire resolved rule set between a spartan file and a first-party one,
  so a glob that starts matching more than it was written to fails here.
- `@typescript-eslint/no-deprecated` is severity 2 with
  `parserOptions.projectService === true`, since a file the project service does not
  own is skipped rather than reported.
- `@nx/enforce-module-boundaries` is severity 2.
- Angular templates resolve through a parser whose name contains `template-parser`,
  because a config change collapsing templates onto the TypeScript parser would leave
  them reporting nothing while `pnpm lint` stayed green.
- `libs/ui` and the vendored kit carry **distinct** `ui:*` tags. If those collapse back to
  being equal, every UI vendor ban below covers both or neither, and lint still passes.
- The UI vendor bans hold as a table of tier against package, asserting both what each tier
  is refused **and** what it must keep — a ban that widens onto the wrapper layer is as much
  a regression as one that disappears.
- Every `bannedExternalImports` glob ends in `*`. Without it the pattern matches only the
  bare specifier, which nothing imports, so the rule reports success while enforcing
  nothing.
- Nothing is staged any more. The four vendor bans were held at `warn` on the **core**
  `no-restricted-imports` only while the 103 known violations were being worked off; that
  block is deleted, and every ban is now an error carried by `depConstraints`. The invariant
  asserts the absence, so re-introducing a staged block fails the suite rather than quietly
  reopening the gate.
- `no-restricted-syntax` over `libs/feature/**` still carries the `matrix-js-sdk`
  `ImportExpression` selector. Flat config replaces a rule's options wholesale, so a second
  entry over those globs would delete it without a word — leaving
  `await import('matrix-js-sdk')` legal in feature code while lint stayed green. Every route
  here is lazy, so that selector is the half that matters.

Counting rules was rejected deliberately: that fails on every legitimate rule
addition and gets deleted the first time it cries wolf.

Resolving real configs is slow enough that the `scripts` project raises Vitest's default
test timeout to accommodate it — the reason is recorded in
[Testing](testing.md#the-scripts-project-runs-plain-node-on-a-raised-timeout), because a
timeout here reads like a hang rather than the loaded runner it usually is.

### The stack versions spec

[`stack-versions.spec.mjs`](https://github.com/quwisky/trinity-matrix-client/blob/develop/scripts/stack-versions.spec.mjs)
reads [`docs/reference/stack.md`](../reference/stack.md) **at module load** and
parses its version table. For every row whose version cell is a complete `x.y.z`
semver, it asserts the documented version equals the one installed on disk in
`node_modules/<package>/package.json`. Rows that abbreviate on purpose are skipped,
because forcing those into exact versions would make the table worse to read.

The page claims its rows are "as installed" — a claim a reader can check, and
therefore one the repository should not break. It broke repeatedly across four
dependency waves, corrected by hand each time, once with the correction itself
leaving another row stale.

!!! danger "Reformatting the stack table can break pnpm test"

    Three ways to turn this suite red or, worse, empty:

    - **Moving or renaming the file.** `readFileSync` runs at module scope, so
      `pnpm test` fails with `ENOENT` before a single test executes.
    - **Changing the row shape.** The regex expects
      `` | `package-name` | 1.2.3 | … `` with the package name in backticks in the
      first cell and the version in the second.
    - **Reducing the number of exact rows.** A floor assertion requires at least ten
      checkable rows. Without it, a table rewrite would leave a suite that verifies
      nothing while still reporting green.
    - **Putting anything else in the name cell.** An inline `<!-- … -->` note after the
      backticked package silently stops the row matching, and the floor is far too coarse
      to notice one row of fifty going dark. A second assertion now fails on any row whose
      second cell is a semver but which the parser does not pick up.

### The host-directives spec

`scripts/host-directives.spec.mjs` reads every non-spec `.ts` under `libs/` and `apps/` and
requires each `hostDirectives` entry to state its `inputs` and `outputs` explicitly, even when
the answer is `[]`. `hostDirectives` **is** public API: a composed directive's input is
bindable on our element only if the entry lists it, and the shorthand form exposes nothing —
which is usually right, but is a decision nobody made. Trinity shipped that bug once, when
`HlmInput` composed `BrnFieldControlDescribedBy` without listing `aria-describedby`, so the
attribute was silently overwritten with null and could not be set at all.

It carries the same shape of floor assertion as the two above — it asserts it found entries at
all — so a parser change that matched nothing cannot pass as a clean sweep.

    If you restructure that table, run `pnpm exec nx test scripts` before committing.

A fourth spec in the same project drives the build-info generator against a temporary
manifest and an injected fake `git`, deliberately never reading the real repository
version — a release bump from 0.0.1 to 0.1.0 had broken it once.

## Releases

A release is cut by pushing an annotated version tag. The workflow is triggered by
`push: tags: ['v[0-9]+.[0-9]+.[0-9]+']`, so pre-release tags like `v1.2.3-beta.1`
deliberately do not match — they would publish installers named after a version this
pipeline never verified. `workflow_dispatch` takes an existing tag as input, which is
the normal recovery path, because artifacts are immutable per run and re-running must
not require deleting and re-pushing a tag.

`concurrency` is keyed on the tag with `cancel-in-progress: false`. A half-uploaded
draft is worse than a slow one.

### The verify job is the entire gate

A tag push triggers **no** `ci.yml` run at all. Nothing else will ever check that
commit, so `verify` carries the whole load. It does three things before it runs any
gate.

**Ancestry.** The tagged commit must be reachable from `origin/develop` or
`origin/master`. A tag is not evidence of review — anyone who can push one can point
it at an arbitrary commit — so this requires that the code went through a pull
request. It is why the job checks out with `fetch-depth: 0`.

**Version agreement.** The tag minus its `v` must equal the version in **both**
`package.json` and `electron/package.json`. electron-builder names every artifact
after the manifest version, not the tag, so a mismatch silently ships
`Trinity Setup 0.1.0.exe` for tag `v0.3.0`. This enforces the repository's own rule
that the version bump and the changelog entry land in one release commit.

**The gates themselves.** `pnpm lint`, `pnpm stylelint`, `pnpm format:check`,
`pnpm test`, `pnpm build`, then `pnpm -C electron install --frozen-lockfile` and
`pnpm -C electron test`.

!!! warning "A release runs no browser or Electron end-to-end test"

    `verify` deliberately skips both `nx e2e trinity-e2e` and `pnpm electron:e2e`. An
    installer can therefore ship from a commit whose UI journeys were never exercised
    on that exact tree. The mitigating control is the ancestry gate: the commit is
    contained in a long-lived branch, so it went through a pull request where all
    five CI jobs did run. That control is only as strong as the branch's protection
    rules.

### Packaging, and the environment gate on signing

The `package` job is a three-leg matrix with `fail-fast: false` and a 45-minute
timeout, so one platform's toolchain breaking does not deny you the other two.

| Runner           | Flag      | Produces                      |
| ---------------- | --------- | ----------------------------- |
| `ubuntu-latest`  | `--linux` | `.AppImage` and `.deb`        |
| `macos-latest`   | `--mac`   | `.dmg` and `.zip`, arm64 only |
| `windows-latest` | `--win`   | `.exe`                        |

macOS is arm64 only by choice: `macos-latest` is Apple Silicon and electron-builder
defaults to the host architecture.

The job declares `environment: release`. Until required reviewers are configured on
that environment in repository settings the declaration is a no-op; once secrets
exist it is what stops a pushed tag from minting a signed installer unattended. The
certificate is the asset worth protecting, because electron-builder runs
repo-controlled hooks — `afterPack.cjs` and `build/notarize.cjs` — in the same
process that holds `CSC_KEY_PASSWORD`.

It runs `pnpm build`, the desktop install, `pnpm -C electron run build`, and then
`electron-builder <flag> --publish never` directly. It deliberately does **not** call
`pnpm electron:build`, which ends in a dev-signing step against a local `trinity-dev`
identity that exists on no runner.

Signing is wired but optional: with no secrets set the variables resolve to empty and
the artifacts are simply unsigned.

```yaml
CSC_LINK: ${{ matrix.platform == 'mac' && secrets.MAC_CSC_LINK || '' }}
```

The nested `|| ''` is load-bearing. In GitHub expressions `a && b || c` collapses to
`c` whenever `b` is empty, so the plain form would hand the **Windows** certificate to
the macOS build the moment `MAC_CSC_LINK` was unset. `CSC_IDENTITY_AUTO_DISCOVERY` is
forced to `secrets.MAC_CSC_LINK != ''` so a stray keychain identity cannot turn an
unsigned build into a failing one.

Notarization uses the Apple ID style — `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID` — rather than the App Store Connect API-key style that
`notarize.cjs` also supports, because `APPLE_API_KEY` has to be a _path to a .p8
file_, which a secret cannot be. The hook no-ops with a log line unless a full
credential set is present, and only ever touches a darwin build on a darwin host.

### Drafting the release

```yaml
if: ${{ !cancelled() }}
```

Not the default `success()`. A matrix job reports failure if any leg fails, even with
`fail-fast: false`, so the default would skip this entirely when one platform breaks
and throw away the installers that did build — the exact opposite of what
`fail-fast: false` is for. A missing platform produces a warning naming it; the job
hard-fails only when nothing at all landed.

This is the only job with `contents: write`. It branches on the current state of the
release:

| State           | Action                        |
| --------------- | ----------------------------- |
| Does not exist  | `gh release create --draft`   |
| Exists as draft | `gh release upload --clobber` |
| Published       | Hard error, exit 1            |

Refusing to touch a published release is deliberate. `--clobber` **deletes** existing
assets before uploading, and electron-builder output is not bit-reproducible, so even
a same-commit rebuild would silently swap what people had already downloaded. Cut a
new version instead.

Releases are left as drafts on purpose. Nothing is downloadable until a human reviews
the artifacts and presses publish.

## Renovate, and the trigger it silently depends on

[`.github/renovate.json`](https://github.com/quwisky/trinity-matrix-client/blob/develop/.github/renovate.json)
sets `dependencyDashboardApproval: true` globally with no concurrency or hourly
limits, a three-day `minimumReleaseAge`, `semanticCommitType: build` with scope
`deps`, and targets `develop` only. Updates are grouped by family — Angular, Nx,
matrix-js-sdk with its crypto WASM, Capacitor, spartan-ng, Playwright, Vitest,
ESLint, Tailwind, and the whole `electron/` manifest as one group — because members of
each must move together.

Patch updates are the one exempt category: automerged, dashboard-gate-free, and
merged as a **branch** rather than a pull request, on the `renovate/patch-` prefix.

!!! warning "ci.yml's push trigger is what makes patch automerge work"

    Because those branches never become pull requests, the `pull_request` trigger
    never fires for them — which is exactly why `ci.yml` lists `renovate/patch-**`
    among its push branches. The dependency is one-directional and silent: with no
    checks on the branch Renovate declines to merge, waits out its 24-hour pending
    window, and opens a pull request instead. Removing the trigger breaks nothing
    loudly; it quietly turns the whole rule back into ordinary pull requests. The
    prefix is `patch-` rather than `renovate/**` so that dashboard-approved updates,
    which do get a pull request, do not fire all five jobs twice per rebase.

Two rules opt back out of the patch automerge with an empty branch prefix. Security
advisories keep a pull request, so the `security` label and the CVE detail survive.
And GitHub Actions digest bumps stay behind a human: a `v7.0.1` to `v7.0.2` bump is
technically a patch, but it repoints a SHA at third-party code that runs inside CI,
including the release workflow that holds the signing certificates.

TypeScript is capped below 6.1, because `@angular/compiler-cli` peer-depends on a
single minor window and pnpm only warns about an unmet peer. The ceiling has to be
widened by hand at every Angular major — read the new window off
`pnpm view @angular/compiler-cli@<version> peerDependencies`.

The cap covers both manifests: the root workspace and `electron/` share one exact
TypeScript version, grouped into a single branch. The shell used to pin its own 5.9,
which cost more than it saved — `@nx/js` tsconfig codemods glob `electron/tsconfig.json`
on every root bump, and the rewritten file then failed under the older compiler. That
rule must stay below the `electron shell` rule in `packageRules`: Renovate merges
matching rules in array order and the last one wins, so reordering them silently hands
electron's TypeScript back to the shell group and restores the divergence.

`renovate.yml` runs on a daily UTC cron with `timeout-minutes: 55`, because a GitHub
App installation token lives exactly one hour and a 60-minute job could outlive its
own credential mid-run. It authenticates through `actions/create-github-app-token`
using the App's `client-id` — the `Iv…` string, not the numeric app id. A plain
`GITHUB_TOKEN` would not trigger the workflows its pull requests need.

## Gaps worth knowing about

- **Specs are type-checked by nothing.** See
  [Testing](testing.md#specs-are-type-checked-by-nothing).
- **Root-level TypeScript is linted by nothing.** `lint` is an inferred target that
  runs `eslint .` with `cwd` set to each project root, and no Nx project is rooted at
  the repository root. The lint-staged glob is `{apps,libs,electron}/**/*.ts`, which
  does not match a root file either. So an unused import in `vite.base.config.ts` or
  `test-setup.base.ts` fails neither `pnpm lint` nor a commit; only Prettier reaches
  them.
- **CI never exercises the Electron secure-storage round trip.** The spec branches on
  keyring availability and asserts the degradation contract on a headless runner.
