# Android Clear-All-Data Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate issue #721's Android-applicable clear-all-data journeys to a
deterministic installed-Android Maestro/Node suite with all 25 stage-local
obligations preserved.

**Architecture:** A source-pinned contract defines six stages, 25 identities
and the Android hover exclusion. A dedicated observer reads native preferences,
IndexedDB and rendered colour without acting on the product; the journey uses
Maestro-native input for every user action and reattaches after the wipe swaps
the WebView document.

**Tech Stack:** TypeScript ESM, Node assertions/tests, Maestro, Android ADB,
Capacitor Preferences, WebView CDP observation, disposable Synapse, Nx/Vitest
and GitHub Actions.

**Spec:**
`docs/superpowers/plans/2026-09-16-android-clear-all-data-design.md`

## Global Constraints

- Keep all six Playwright predecessors enabled and unchanged.
- Pin the three exact SHA-256 hashes recorded by the design.
- Use Maestro-native input for every reachable product action.
- Observation must not click, focus, fill, submit, navigate, dispatch pointer
  events or invoke product handlers.
- Prove native Preferences erasure from `CapacitorStorage.xml`; never use
  WebView `localStorage` as Android Preferences evidence.
- Record exactly 25 unique stage-local identities once per passing run.
- Run with one attempt, zero retries and serialized `android-avd` + `synapse`.
- Do not merge PR #677.

---

### Task 1: Lock source shape and the 25-identity contract

**Files:**

- Create: `scripts/clear-all-data-migration.spec.mjs`
- Create: `e2e/android/clear-all-data-contract.mts`

**Interfaces:**

- Consumes: the three source files and hashes in the design.
- Produces: `CLEAR_ALL_DATA_SOURCES`,
  `clearAllDataFunctionalAssertions`, `clearAllDataVisualAssertions`,
  `clearAllDataAssertions`, `CLEAR_ALL_DATA_HOVER_EXCLUSION`, and
  `ClearAllDataAssertion`.

- [x] **Step 1: Write the source/contract guard first**

  Guard the owned line spans, exactly 14 direct assertion sites, two helper
  expansions, four visual definitions, the 11 + 2 + 12 stage-local identity
  split, predecessor retention and all product-action prohibitions.

- [x] **Step 2: Run the focused guard and preserve RED**

  Run:
  `pnpm exec vitest run --config scripts/vitest.config.mjs scripts/clear-all-data-migration.spec.mjs`

  Expected: fail because the contract, observer, journey and wiring do not yet
  exist.

- [x] **Step 3: Add the exact identity contract**

  Export 13 functional identities and generate 12 visual identities from:

  ```ts
  const visualCases = [
    ['trinity', 'light'],
    ['trinity', 'dark'],
    ['amethyst', 'light'],
    ['amethyst', 'dark'],
  ] as const;
  const visualChecks = ['applied', 'danger-token', 'aa-contrast'] as const;
  ```

  Assert 25 keys, 25 unique values and the precise `hover: none` /
  `pointer: coarse` exclusion.

- [x] **Step 4: Re-run the focused guard**

  Expected: the contract section passes; missing implementation/wiring remains
  RED.

- [x] **Step 5: Commit the reviewable contract slice**

  Stage only the contract, guard, design and plan and commit with
  `test(e2e): define Android clear-data contract`.

### Task 2: Implement the read-only storage and visual observer

**Files:**

- Create: `e2e/android/clear-all-data-observer.mts`
- Modify: `scripts/clear-all-data-migration.spec.mjs`

**Interfaces:**

- Consumes: `AccountWorkspaceClient.webview`, `MaestroDevice.adb`,
  `evaluateNative`, and the Android application id `eu.qwky.trinity`.
- Produces:

  ```ts
  interface ClearAllDataSnapshot {
    readonly preferenceKeys: readonly string[];
    readonly databases: readonly string[];
    readonly documentTimeOrigin: number;
  }
  interface ClearAllDataVisualObservation {
    readonly applied: { readonly dark: boolean; readonly theme: string | null };
    readonly media: { readonly hoverNone: boolean; readonly coarsePointer: boolean };
    readonly danger: Srgb;
    readonly text: Srgb;
    readonly background: Srgb;
    readonly ratio: number;
    readonly layers: readonly string[];
  }
  snapshot(client): Promise<ClearAllDataSnapshot>;
  seedPreference(client, key, value): Promise<void>;
  waitForRestartedEmptyState(client, previousDatabases, previousTimeOrigin): Promise<ClearAllDataSnapshot>;
  observeVisual(client): Promise<ClearAllDataVisualObservation>;
  ```

- [x] **Step 1: Extend the guard with observer restrictions**

  Require `run-as eu.qwky.trinity cat shared_prefs/CapacitorStorage.xml`,
  `indexedDB.databases()`, Capacitor `Preferences.set`, canvas colour
  resolution/compositing and WCAG luminance. Reject DOM action/navigation and
  localStorage evidence.

- [x] **Step 2: Run focused guard and preserve observer RED**

  Expected: fail on missing observer.

- [x] **Step 3: Implement authoritative preference parsing and snapshots**

  Parse XML `<string name="…">` keys from the host, return an empty namespace
  for a missing file, enumerate only non-empty IndexedDB names, and poll both
  channels across the document replacement with a finite timeout.

- [x] **Step 4: Implement setup-only bridge seeding**

  Call `window.Capacitor.Plugins.Preferences.set({key, value})`, then reattach by
  reloading through the existing bounded WebView lifecycle seam. Never mutate
  storage directly.

- [x] **Step 5: Implement rest-state visual observation**

  Resolve the label and token through a 1×1 canvas, composite backgrounds to
  the first opaque ancestor, calculate WCAG 2.1 contrast, and return media
  queries plus applied root state.

- [x] **Step 6: Run focused guard and Android typecheck/lint**

  Run:

  ```text
  pnpm exec vitest run --config scripts/vitest.config.mjs scripts/clear-all-data-migration.spec.mjs
  pnpm nx run trinity-e2e-android:typecheck
  pnpm nx run trinity-e2e-android:lint
  ```

  Expected: observer checks pass; the still-missing journey/wiring remains RED.

### Task 3: Implement the six-stage native journey

**Files:**

- Create: `e2e/android/clear-all-data-journeys.mts`
- Modify: `scripts/clear-all-data-migration.spec.mjs`

**Interfaces:**

- Consumes: Task 1 identities and Task 2 observer functions.
- Produces: one Node test named `Android clear-all-data journeys` that records
  every identity exactly once and writes redacted pass/failure artifacts.

- [x] **Step 1: Guard native action ownership and exact stage count**

  Require `client.openMenu()`, `client.tap('[data-testid="add-account"]')`,
  `client.tapCurrent('[data-testid="clear-all-data"]')`,
  `client.fill('trn-alert-dialog input', word)` and
  `client.tapCurrent('[data-testid="alert-confirm"]')`. Reject direct
  navigation and DOM action mutations.

- [x] **Step 2: Implement the signed-in stage**

  Register/sign in a disposable account; prove the native account preference,
  sync DB and crypto DB. Open Add account natively, prove the escape hatch,
  enter `yes please`, prove exact `Type RESET TRINITY exactly` feedback and an
  unchanged snapshot, then enter lower-case `reset trinity`. Reattach after the
  document swap and prove empty preferences, removal of every prior DB and the
  visible Homeserver field.

- [x] **Step 3: Implement the signed-out wedged stage**

  Reset the app, seed
  `trinity.push.gateway=https://dead.example/_matrix/push/v1/notify` through the
  Capacitor bridge, prove the key on disk, confirm with uppercase
  `RESET TRINITY`, reattach, and prove the full native namespace empty.

- [x] **Step 4: Implement four isolated visual stages**

  For each Trinity/Amethyst × light/dark pair, reset the app, seed exact mode
  and theme descriptors, observe the escape hatch at rest, require applied
  root state, `hover: none`, `pointer: coarse`, exact danger-token equality and
  contrast `>= 4.5`.

- [x] **Step 5: Add artifact, teardown and assertion accounting**

  Capture pass/failure proof, redact secrets, close the WebView/device under
  aggregate-error cleanup, and assert the recorded identity set equals all 25
  contract values with no duplicates.

- [x] **Step 6: Run focused guard and static checks**

  Expected: contract, observer and journey sections GREEN; only registry/CI or
  documentation sections may remain RED.

- [x] **Step 7: Commit the implementation slice**

  Stage the contract/observer/journey/guard/design/plan files and commit with
  `test(e2e): migrate Android clear-all-data journeys`.

### Task 4: Register Nx, registry and hosted execution

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `package.json`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `e2e/registry/commands.mts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`
- Modify: `scripts/clear-all-data-migration.spec.mjs`

**Interfaces:**

- Produces suite id `android.clear-all-data`, Nx target `clear-all-data`, package
  script `e2e:android:clear-all-data`, serialized resources and a started-only
  `android-clear-all-data` diagnostic upload.

- [x] **Step 1: Add RED registry/workflow expectations**

  Require uncached/non-parallel execution, Android build dependency, a bounded
  timeout, AVD + Synapse resources, shortest-shard registration and the exact
  started-output artifact condition.

- [x] **Step 2: Run focused registry/workflow guards and preserve RED**

  Run focused Vitest for the migration, suite registry and CI workflow guards.

- [x] **Step 3: Add Nx/package/registry/workflow wiring**

  Wire the exact names above and place the suite on the shortest suitable shard
  from the latest completed hosted timing evidence without reordering unrelated
  suites.

- [x] **Step 4: Re-run focused registry/workflow guards**

  Expected: GREEN.

### Task 5: Document parity and validate locally

**Files:**

- Modify: `e2e/android/MIGRATION.md`
- Modify: `docs/superpowers/plans/2026-09-16-android-clear-all-data.md`

**Interfaces:**

- Produces a reviewable parity ledger with source hashes, 25 identities,
  boundaries, exclusion, invocations, artifacts and exact validation evidence.

- [x] **Step 1: Document the suite and predecessor retention**

  Record the 11 + 2 + 12 identity split, authoritative preference boundary,
  hover exclusion, command, one-attempt policy and pass/failure evidence paths.

- [x] **Step 2: Run effective negative controls**

  Deliberately prove guard failures for: vacuous signed-in pre-state, weakened
  mistype preservation, missing native preference erasure, missing IndexedDB
  erasure, missing signed-out restart, visual token drift, contrast drift, and
  cleanup/redaction loss. Restore each mutation and re-run GREEN.

- [x] **Step 3: Run three unchanged installed-Android first attempts**

  Run `pnpm nx run trinity-e2e-android:clear-all-data` three times sequentially.
  Require zero retries, all six stages, all 25 identities exactly once,
  provenance/redaction and clean teardown.

- [x] **Step 4: Run all six exact Playwright predecessors sequentially**

  Run the two functional and four generated visual tests at retry zero using
  the repository browser target and its documented name filter.

- [x] **Step 5: Run the full selected validation set**

  Run focused/full script guards, E2E registry guards, Android/browser
  typecheck and lint, format check, documentation gates and the source-selected
  Nx validation from `docs/contributing/testing.md`.

- [x] **Step 6: Review and commit**

  Review the complete diff, resolve all findings, check the plan's local
  acceptance items, and commit remaining task-owned files with
  `test(e2e): register Android clear-all-data suite`.

### Task 6: Publish and obtain hosted acceptance

**Files:**

- Modify after evidence: `e2e/android/MIGRATION.md`
- Modify after evidence: this plan

**Interfaces:**

- Produces identical verified trees on `test/721-android-clear-all-data` and
  `test/676-android-sidebar-filter`, issue/PR evidence and closed issue #721.

- [x] **Step 1: Push the feature branch**

  Push `test/721-android-clear-all-data` without rewriting history.

- [x] **Step 2: Integrate the verified commits into the consolidated branch**

  Cherry-pick only the #721 commits into `test/676-android-sidebar-filter`,
  prove identical trees, and push. Do not merge PR #677.

- [ ] **Step 3: Audit original-attempt hosted evidence**

  Require exact-head original-attempt Android suite, all retained browser
  predecessors and renderer verification. Audit artifacts, assertion ledger,
  provenance, redaction and teardown logs; route infrastructure-only failures
  separately.

  Exact-head run `35153211229` stopped before this suite when unchanged Space
  Settings login hit the now-fixed Maestro wildcard-port mismatch. Replacement
  run `35156372765` verified the renderer and all six clear-all-data browser
  predecessors at retry zero, but shard 4 stopped before this suite in unchanged
  `android.member-role-live-updates`: its first three stages passed and the
  touch-feedback stage never produced transition copy after a trusted native
  tap. Artifact `10472873279`, digest
  `sha256:306b3a754dcb95be49d3dab389f930cdc97dc7a1a4b4319b365f8e7fd98072a8`,
  records that independently tracked failure. A fresh original-attempt Android
  artifact remains required.

- [ ] **Step 4: Record and publish acceptance**

  Add exact run/job/artifact IDs and digests to the migration ledger and mark
  this plan's acceptance. Commit/push that documentation to both branches.

- [ ] **Step 5: Update trackers and close only #721**

  Comment on #721, #660, #653 and PR #677 with the exact evidence, then close
  #721. Leave PR #677 open and unmerged.

## Acceptance evidence

- [x] Focused contract starts RED and ends GREEN.
- [x] All eight effective negative controls fail their intended guard and are
      restored.
- [x] Three unchanged-input Android runs and all six exact predecessors pass at
      retry zero.
- [x] Static, documentation, format and full-script gates pass.
- [x] Review has no unresolved findings.
- [ ] Original-attempt hosted Android/browser/renderer evidence is audited.
