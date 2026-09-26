# Android Pinned Message Panel Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical pinned-
message panel definition while preserving its Playwright predecessor and
proving row-specific unpinning against both the live panel and authoritative
Matrix pinned state.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, all twelve direct identities and every forbidden shortcut. A fixture
layer arranges one disposable private Room with exact ordered `unpin-me` and
`keep-me` events and publishes their ids in `m.room.pinned_events`. One serial
Node/Maestro stage opens the Room/panel and taps the exact observed unpin row
natively. Read-only renderer observations prove count, content, persistence and
used header/title geometry; bounded REST observation proves pinned state
converges to the single kept event.

**Issue:** #756, blocked on #755 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned pinned-message-panel predecessor, application-login and
  account sources unchanged.
- Record exactly twelve unique direct identities in one stage, including the
  source's non-null geometry preconditions rather than collapsing them away.
- Arrange one exact Account/private Room, ordered message pair and initial pin
  state through real Synapse. Do not mock or rewrite renderer pin state.
- Maestro/native device input owns every product action: login, Room
  navigation, toolbar-panel opening and exact row-specific unpin.
- Renderer inspection is read-only. It may observe exact text, count,
  visibility and used geometry but may not click, invoke handlers, focus, fill,
  submit, navigate or rewrite state.
- Accept unpin only when the panel remains open with one exact kept row, the
  targeted row disappears and authoritative `m.room.pinned_events` converges
  to exactly the kept event id. A closed/empty panel is not success.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials/access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/pinned-message-panel-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact definition/fixture spans, message/pin
      order plus application-login and account source hashes.
- [ ] Prove exactly twelve direct assertion sites and require twelve globally
      unique contract identities in one stage.
- [ ] Require exact initial pin order/count, native panel opening, panel
      visibility, all three non-null boxes, equal Room/panel header heights,
      12 px title inset at predecessor tolerance and less than 2 px vertical
      centering imbalance.
- [ ] Require native text/geometry-scoped `unpin-me` action, one remaining item,
      panel persistence, exact `keep-me` retention, `unpin-me` removal and exact
      server pin-state convergence.
- [ ] Reject DOM click/focus/fill/submit/navigation, renderer handler/state
      mutation, mocked pin state, class-only geometry, unscoped first-row taps,
      closed/empty-panel success, retries, unbounded waits and weak cleanup/
      redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for message/pin order and ids, initial/
      final counts, all box values and tolerance boundaries, row text/geometry/
      native target, panel persistence, kept/removed content, server state,
      cleanup and redaction.
- [ ] Run
      `pnpm exec vitest run scripts/pinned-message-panel-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and pinned-state fixture

**Files:**

- Create `e2e/android/pinned-message-panel-contract.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if exact pin-state
  arrangement/observation cannot be composed from existing fixture operations.

- [ ] Export exact source mappings and all twelve identities; assert count and
      uniqueness at module load.
- [ ] Register one fresh Account, create one private Room, send exact run-scoped
      `unpin-me` followed by `keep-me` text messages and retain their ready event
      ids in that order.
- [ ] Publish one `m.room.pinned_events` state event whose `pinned` array is
      exactly `[unpinId, keepId]`, then independently read it back before launch.
- [ ] Add a bounded post-action observer that accepts only the exact latest
      pinned state `[keepId]`, rejecting empty/reordered/duplicate/unrelated
      arrays.
- [ ] Keep credentials/tokens closure-private and return only sanitized Room,
      message and pin-state facts; aggregate teardown must handle partial setup.
- [ ] Extend the focused guard so wrong event/pin ordering, missing readiness,
      weak state matching, unbounded polling or leaked secrets fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement native panel geometry and unpin proof

**Files:**

- Create `e2e/android/pinned-message-panel-journeys.mts`.

- [ ] Sign in and open the exact Room through native actions on the production
      profile, then tap the toolbar pinned control natively.
- [ ] Prove the exact panel is visible and contains exactly two pinned items in
      authoritative pin order.
- [ ] Read Room header, `.panel-header` and title boxes in one renderer turn;
      prove all three exist and have non-zero dimensions.
- [ ] Record the three non-null identities separately, then prove panel/Room
      header heights are equal, title left inset is 12 px at the predecessor's
      zero-decimal `toBeCloseTo` tolerance and top/bottom centering imbalance is
      strictly below 2 px.
- [ ] Scope the target row by exact `unpin-me` text and its visible rectangle;
      resolve only that row's unpin control to device coordinates and tap it
      natively.
- [ ] Prove exactly one pinned item remains, the same panel stays visible,
      `keep-me` remains and `unpin-me` is absent, then require authoritative
      pinned state exactly `[keepId]`.
- [ ] Record all twelve identities exactly once and write started-stage reports,
      pass/failure secret-safe captures, exact assertion accounting and
      fixture/geometry/native-target/panel/server-state receipts.
- [ ] Scan aggregate diagnostics for credentials/tokens; always clear
      application data, close the client and release Matrix/device resources,
      including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `pinned-message-panel` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.pinned-message-panel` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-unread with a bounded
      wrapper and started marker; add started-only
      `android-pinned-message-panel` diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, twelve identities, ordered fixture, native
      panel/unpin actions, used geometry, persistent live projection,
      authoritative state convergence, secrets and teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:pinned-message-panel --skipNxCache`
      three times sequentially on unchanged inputs; require 1/1 stage, 12/12
      identities, attempt 1 and retries 0 each time.
- [ ] Audit fixture order, all raw geometry/tolerance calculations, exact
      native row target and final renderer/server pin state; require no raster
      artifacts and clean Matrix/application/device teardown.
- [ ] Run the complete unchanged pinned-message-panel browser predecessor with
      one worker and `--retries=0`; require the exact definition to pass and
      recheck all three pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 6: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor, dedicated Android artifact, 1/1 stage, 12/12
      identities, attempt 1/retries 0, fixture/panel/geometry/native-target/
      live-projection/server-state receipts, redaction, teardown and clean
      worktree.
- [ ] Post evidence to #756, #660, #653 and PR #677; close #756 only after all
      acceptance evidence is complete, then continue with #757.
