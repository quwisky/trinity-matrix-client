# Android Message Swipe Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for all fourteen canonical
message-swipe/edge-gesture definitions while preserving their Playwright
predecessors and proving held, partial, complete, compositor-scroll and drawer
gestures through real device-coordinate native motion.

**Architecture:** A focused Vitest guard pins the predecessor, navigation,
touch and shared login sources, the exact fourteen-stage/74-identity ownership
and every forbidden shortcut. A fixture layer arranges paired Accounts/Rooms,
exact own/other messages and two 30-filler long Rooms. A native motion driver
uses device coordinates and supports bounded down/move/hold/up/cancel sequences;
its capability and compositor panning are proven by a hard feasibility probe.
One serial Node/Maestro journey covers action binding, affordance feedback,
preference/direction, abandonment, vertical panning, edge/drawer coexistence and
live Settings changes while renderer and Preferences observations remain
read-only.

**Issue:** #754, blocked on #753 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-swipe predecessor, navigation helper, touch
  helper, application-login/Preferences and account sources unchanged.
- Record exactly 74 globally unique identities across fourteen stages,
  preserving 38 direct plus 36 helper-expanded records: two Room readiness at
  each call site, two long-Room back-pagination and six inherited native
  Settings navigation identities.
- Arrange paired Accounts/Rooms with exact own/other messages and exactly 30
  filler events for both long-Room stages through real Synapse.
- Seed `trinity.message-swipe = right|left|off` only for behavior definitions;
  the live-setting definition must start Off and change to Right through real
  Settings → Appearance product controls.
- Maestro/native device input owns all product actions and every held/partial/
  complete/edge gesture. Never dispatch CDP/DOM pointer events or mutate action
  state in the renderer.
- Native Preferences and renderer observations are read-only during assertions.
  They may observe exact persisted value, action, geometry, style and scroll
  state but may not assign scroll offsets, call scrolling APIs, mutate classes/
  styles, invoke handlers, focus, fill, submit or navigate.
- The vertical-scroll stage requires a reviewed hard feasibility artifact from
  the installed device. If held/interpolated native input or compositor panning
  is unavailable, exclude only that affected stage with exact evidence; never
  substitute renderer/CDP scrolling.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device/held-touch teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials/access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-swipe-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact fourteen definition/helper/preference/
      edge spans plus navigation, touch, application and account hashes.
- [ ] Prove exactly 38 direct assertions, fourteen Room-helper calls expanding
      28 readiness records, two long-Room pagination records and six Settings
      navigation records.
- [ ] Require exact fourteen stage ids and 74 globally unique identities,
      including the predecessor's Android-skipped compositor definition.
- [ ] Require a real native down/move/hold/up/cancel driver, device-coordinate
      records and a hard feasibility probe for held interpolation plus actual
      compositor panning.
- [ ] Require own/edit and other/reply binding; partial edit/reply affordances;
      progressive opacity/scale/colour; Off, Left/rejected Right, trailing-strip
      geometry and abandonment; vertical scroll; edge dead zones/inset drawer;
      Left/Off/Right drawer coexistence; and live no-reload setting update.
- [ ] Reject CDP/DOM pointer dispatch, `scrollTo`/`scrollIntoView`, direct scroll
      assignment, `--swipe-drag`/class/style mutation, simulated action state,
      preference seeding in the live-setting stage, DOM click/focus/fill/
      submit/navigation, retries, unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for gesture coordinates/phases/duration,
      every action/visual/geometry/preference/scroll/drawer outcome, feasibility
      proof/exclusion shape, held-touch release, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/message-swipe-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add contracts, paired fixtures and native preference support

**Files:**

- Create `e2e/android/message-swipe-contract.mts`.
- Create `e2e/android/message-swipe-fixtures.mts`.
- Create `e2e/android/message-swipe-preference.mts` if no exact fail-closed
  native preference observer/seeder is reusable.

- [ ] Export exact source mappings, fourteen stage ids, per-stage assertion
      maps and all 74 identities; assert totals and global uniqueness at module
      load.
- [ ] Arrange fresh paired Accounts/Room per stage, exact ordered other/own text
      events and exactly 30 later filler events in both long-Room stages.
- [ ] Return exact ready event ids/bodies/senders and sanitized Room facts while
      keeping credentials/tokens closure-private; provide bounded aggregate
      teardown for every Account/Room.
- [ ] Seed only exact `trinity.message-swipe` values into native Capacitor
      Preferences while the app is stopped, and observe the same key fail-closed
      without returning raw Preferences XML.
- [ ] Ban seeding in the live-setting stage and prove its initial native value
      is `off` before launch.
- [ ] Extend the focused guard so wrong event order/sender/filler count,
      renderer/localStorage preference shortcuts, raw native storage leakage,
      unbounded setup or incomplete cleanup fails.
- [ ] Run the focused guard to the native-motion-only RED boundary and run
      Android typecheck.

## Task 3: Add the native held-motion driver and hard feasibility gate

**Files:**

- Create `e2e/android/native-motion.mts` or narrowly extend an existing native
  input primitive without changing unrelated semantics.

- [ ] Resolve physical WebView/device coordinates from exact visible renderer
      boxes and device profile transforms; reject zero/off-screen/ambiguous
      targets.
- [ ] Implement bounded native down, interpolated move, hold, up and cancel
      phases with explicit active-pointer ownership and `finally` release.
- [ ] Record only sanitized coordinates, monotonic timestamps, phase/duration
      and device-input command outcome; never synthesize renderer events.
- [ ] Probe held interpolation on a harmless exact in-row path and prove the
      renderer observes a live drag state before release, then cancel and prove
      no action/style residue.
- [ ] Probe compositor panning in a long Room using one pure vertical native
      motion and read-only before/after timeline state. Require non-zero real
      movement without composer action.
- [ ] Produce a machine-readable `feasible` receipt or a fail-closed reviewed
      exclusion containing exact unsupported primitive/behavior and device/APK
      provenance; no generic timeout-only exclusion is valid.
- [ ] Extend the focused guard so missing pointer release, renderer input,
      fabricated feasibility, DOM-scroll fallback or weak exclusion evidence
      fails.
- [ ] Run native-motion focused tests and the real emulator feasibility probe
      before implementing journey assertions.

## Task 4: Implement commit, partial and progressive gesture stages

**Files:**

- Create `e2e/android/message-swipe-journeys.mts`.

- [ ] Right/own stage: perform a safe committed native row swipe and prove the
      exact own event opens Editing.
- [ ] Right/other stage: perform the same exact gesture on the other event and
      prove Replying targets that message.
- [ ] Partial stage: hold/release sub-threshold native drags on exact own and
      other rows; prove the exact edit/reply affordance each time and no commit.
- [ ] Progressive stage: hold the exact row at ordered increasing displacements
      and prove opacity grows to exactly one while scale and colour change
      before release; retain non-vacuous before/mid/final computed values.
- [ ] Record each owned identity once and guarantee every held pointer is
      cancelled or released even when an observation fails.

## Task 5: Implement preference, direction, abandonment and scroll stages

- [ ] Off stage: prove safe native row gestures never arm an affordance or
      trigger edit/reply.
- [ ] Left stage: prove a Right drag is rejected, a safe leftward drag commits
      the exact action, and the affordance remains completely inside the newly
      uncovered trailing strip using real boxes.
- [ ] Abandonment stage: perform exact horizontal-then-vertical native motion;
      prove no composer action and no residual drag style after release.
- [ ] Vertical stage: after its hard feasibility gate, use a pure vertical
      native motion and prove real compositor timeline movement with no composer
      action. If and only if infeasible, emit the reviewed exclusion artifact
      and record no substituted assertions.
- [ ] Preserve the exact two long-Room back-pagination identities without using
      renderer scroll mutation in the migrated journey.

## Task 6: Implement edge/drawer and live-setting stages

- [ ] Edge-dead-zone stage: prove gestures from exact extreme left/right edges
      do not arm row actions; prove the adjacent right inset opens the member
      drawer; then prove one safe in-row gesture works as the positive control.
- [ ] For exact seeded Left, Off and Right stages, prove native edge gestures
      open and close the drawer and row gestures remain suppressed while the
      drawer overlays the Room.
- [ ] Live-setting stage: start with authoritative native Off, navigate natively
      to Settings → Appearance, choose Right, observe exact native preference,
      close/unwind Settings and return to the same Room without reload.
- [ ] Prove the same event row's Right affordance/action becomes live
      immediately through a native gesture and record all six inherited
      Settings navigation identities.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, fixture/preference/motion/visual/geometry/scroll/
      drawer/feasibility receipts and aggregate cleanup/redaction scans.
- [ ] Always release active touches, clear application data, close observers
      and release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 7: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-swipe` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-swipe` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-spoiler with a bounded
      wrapper and started marker; add started-only `android-message-swipe`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout, artifact path
      and hard feasibility/exclusion receipt.
- [ ] Document pinned ownership, 74 identities/fourteen stages, native motion,
      preference seeding boundary, action/visual/geometry/scroll/drawer/live-
      setting contracts, exclusion policy, secrets and teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 8: Local runtime and repository acceptance

- [ ] Run the focused guard, native-motion tests/probe and all source-selected
      static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-swipe --skipNxCache` three
      times sequentially on unchanged inputs; require every feasible stage and
      identity to pass, attempt 1 and retries 0, with identical reviewed hard-
      gate exclusions only for genuinely infeasible stages.
- [ ] Audit every motion phase/coordinate, pointer release, preference/action/
      visual/geometry/scroll/drawer receipt and exclusion; require no raster
      artifacts and clean Matrix/application/device teardown.
- [ ] Run the complete unchanged message-swipe browser predecessor with one
      worker and `--retries=0`; require all fourteen canonical-browser
      definitions to pass, retain the existing Android Playwright compositor
      skip unchanged and recheck all five pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 9: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, native-input integrity, test quality and
      recoverability; resolve every finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor, dedicated Android artifact, every feasible
      stage/identity, attempt 1/retries 0, fixture/preference/native-motion/
      action/visual/geometry/scroll/drawer/live-setting/feasibility receipts,
      redaction, teardown and clean worktree.
- [ ] Post evidence to #754, #660, #653 and PR #677; close #754 only after all
      acceptance evidence is complete, then continue with #755.
