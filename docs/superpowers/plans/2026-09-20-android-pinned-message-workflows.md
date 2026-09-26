# Android Pinned Message Workflows Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for both applicable canonical
pinned-message workflows while preserving all Playwright predecessors and
excluding only the explicitly desktop-responsive geometry definition from the
Android claim.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact two-stage/26-identity ownership, desktop-only exclusion and
every forbidden shortcut. One serial Node/Maestro journey runs a native
pin/panel/jump/unpin workflow and a seeded repeat-jump regression after exactly
32 live filler events. Matrix observations prove pin/unpin state round trips;
read-only renderer observations prove badge, panel, flash and viewport state,
while native gestures/product controls return to latest without renderer
scrolling.

**Issue:** #757, blocked on #756 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned pinned-message-workflow predecessor, application/action-
  sheet and account sources unchanged.
- Record exactly 26 globally unique identities across two stages: 25 direct
  plus one first-stage action-sheet readiness. Stage totals are 12 for the full
  workflow and 14 for repeat jump.
- Preserve and explicitly exclude lines 402–445 from Android migration: they
  compare a default 1280 px desktop member column/divider to a programmatically
  resized 1000 px browser viewport.
- The full workflow may arrange its Account/Room/two messages through REST but
  must pin and unpin through native product actions. Only the repeat-jump
  fixture may seed the exact initial pinned state.
- Maestro/native device input owns every product action: login, Room navigation,
  long press/sheet Pin, panel open/close, exact pin-row jump, row unpin and
  return-to-latest movement.
- Renderer inspection is read-only. It may observe exact text/count/class/
  visibility/viewport position but may not click, invoke handlers, call
  scrolling APIs, assign offsets, resize the WebView, focus, fill, submit or
  navigate.
- Each jump must target the same exact ready event id, close the panel, enter
  the viewport and acquire real `msg--flash` within the source's 1.5-second
  bound. The first jump does not prove the unchanged-id repeat regression.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials/access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/pinned-message-workflows-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact two applicable definition/helper/
      constant spans, action-sheet call count, filler count plus application and
      account source hashes.
- [ ] Prove exactly 25 direct assertions plus one action-sheet readiness
      identity and require two stages with exact counts `12 + 14 = 26`.
- [ ] Pin the desktop-only definition span and require explicit exclusion from
      Android contracts/journeys while retaining it unchanged and registered in
      canonical browser coverage.
- [ ] Require native pin/unpin/jump ownership; exact badge/panel/body/empty-state
      transitions; server pin-state round trips; first flash/viewport/close;
      exact 32 live fillers/offscreen setup; native return-to-latest; and second
      same-event flash/viewport/close.
- [ ] Reject seeded first-workflow pin state, DOM click/focus/fill/submit/
      navigation, handler invocation, renderer `scrollTo`/`scrollIntoView` or
      offset assignment, WebView resize, first-jump-only evidence, retries,
      unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and all predecessor
      retention.
- [ ] Add effective mutation controls for fixture bodies/event ids, pin state,
      badge/count/text/empty state, action-sheet target, flash deadline,
      viewport/panel state on both jumps, filler count/order/live timing, native
      return movement, desktop exclusion, cleanup and redaction.
- [ ] Run
      `pnpm exec vitest run scripts/pinned-message-workflows-migration.spec.mjs`
      and preserve the expected RED result.

## Task 2: Add the exact contract and workflow fixtures

**Files:**

- Create `e2e/android/pinned-message-workflows-contract.mts`.
- Create `e2e/android/pinned-message-workflows-fixtures.mts`, reusing exact
  lower-level Account/Room operations where possible.

- [ ] Export exact source mappings, two stage ids, stage counts and all 26
      identities; assert totals and global uniqueness at module load.
- [ ] Full workflow fixture: create a fresh creator/private Room and exact ready
      `just chatting` then `pin me please` events without any pinned state.
- [ ] Repeat fixture: create a fresh creator/private Room and exact ready lead
      plus `pin me twice please` target, then publish/read back pinned state
      exactly `[targetEventId]`.
- [ ] After repeat Room launch, send exactly 32 ordered live filler events
      sequentially through Synapse, retaining the exact last body/id and proving
      all events were accepted after the Room became interactive.
- [ ] Provide bounded pin-state observers requiring `[targetEventId]` after
      native Pin and `[]` after native Unpin in the full workflow.
- [ ] Keep credentials/tokens closure-private and return only sanitized Account,
      Room/event/filler/pin facts; aggregate cleanup must handle partial setup.
- [ ] Extend the focused guard so wrong fixture body/order/id, first pin seeding,
      filler preloading/count mismatch, weak pin state, unbounded REST work or
      leaked secrets fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement native pin, panel, first jump and unpin stage

**Files:**

- Create `e2e/android/pinned-message-workflows-journeys.mts`.

- [ ] Sign in/open the exact Room natively, prove the timeline mounted and
      scope the exact target by ready event id/body.
- [ ] Long-press the target natively, record sheet readiness and select exact Pin
      through native touch; observe authoritative pinned state
      `[targetEventId]` without fixed sleeps.
- [ ] Prove the toolbar badge is exactly `1`, open the panel natively and prove
      visible `Pinned messages` heading, exact target row and body.
- [ ] Tap the exact row natively; from the action timestamp prove the same target
      gains `msg--flash` within 1,500 ms, panel closes and target enters the
      viewport.
- [ ] Reopen the panel natively, tap only that row's Unpin control natively,
      require server state `[]` and prove exact empty-panel copy.
- [ ] Close through native input and prove the badge element is absent. Record
      all twelve stage identities exactly once.

## Task 4: Implement exact live-filler and repeat-jump stage

- [ ] Sign in/open the seeded repeat Room natively and prove the exact target is
      loaded before the live flood.
- [ ] Send exactly 32 live filler events only now; prove the last filler enters
      the viewport and the target becomes out of view while remaining loaded.
- [ ] First jump: open the panel natively, prove heading/target row, tap the
      exact row and prove time-bounded flash, panel close and target viewport.
- [ ] Return to the newest timeline position through native swipes or an exact
      production product control; prove the same target is out of view without
      any renderer scroll operation.
- [ ] Second jump: reopen the panel and tap the same event id again; independently
      prove a new time-bounded flash observation, panel close and target
      viewport. Record all fourteen identities exactly once.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting and fixture/pin/filler/native-action/flash-deadline/
      panel/viewport receipts.
- [ ] Scan aggregate diagnostics for credentials/tokens; always clear
      application data, close the client and release Matrix/device resources,
      including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `pinned-message-workflows` target with the Android
      APK build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.pinned-message-workflows` as required current hosted
      Android coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after pinned-message-panel with a bounded
      wrapper and started marker; add started-only
      `android-pinned-message-workflows` diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout, artifact path
      and desktop-only exclusion.
- [ ] Document pinned ownership, 26 identities/two stages, native pin/unpin/
      jumps, server round trips, 32 live fillers, same-event regression, native
      return-to-latest, desktop exclusion, secrets and teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 6: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run
      `pnpm nx run trinity-e2e-android:pinned-message-workflows --skipNxCache`
      three times sequentially on unchanged inputs; require 2/2 stages, 26/26
      identities, attempt 1 and retries 0 each time.
- [ ] Audit fixture/pin/filler/native action, both independent flash deadlines,
      panel and viewport receipts; require no raster artifacts and clean Matrix/
      application/device teardown.
- [ ] Run the complete unchanged pinned-message-workflow browser predecessor
      with one worker and `--retries=0`; require all three definitions to pass,
      reassert the third remains browser-only and recheck all three pinned source
      hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 7: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor, dedicated Android artifact, 2/2 stages, 26/26
      identities, attempt 1/retries 0, native pin/unpin/panel/first-and-second-
      jump/filler/server-state receipts, desktop exclusion, redaction, teardown
      and clean worktree.
- [ ] Post evidence to #757, #660, #653 and PR #677; close #757 only after all
      acceptance evidence is complete, then continue with #758.
