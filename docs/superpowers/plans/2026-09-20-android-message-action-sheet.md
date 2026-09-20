# Android Message Action Sheet Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for all five canonical phone
message-action-sheet definitions while preserving their complete Playwright
predecessor.

**Architecture:** A focused Vitest guard pins the predecessor, touch gesture
source and shared login sources, all direct/helper assertion expansions and
every forbidden shortcut. Five serial Node/Maestro stages arrange disposable
Matrix Accounts, Rooms and exact ready text events. They use the proven native
long-press and native-swipe seams for message, timeline and sheet actions.
Read-only renderer observations prove the single named phone surface, no-hover
state, target/sheet geometry, virtualization and exact position restoration;
closure-private Matrix observation proves the quick reaction is a real server
event.

**Issue:** #742, blocked on #741 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-action-sheet predecessor, touch-platform,
  application-login and account sources unchanged.
- Record exactly 54 unique identities grouped 18 + 4 + 4 + 18 + 10 across
  `reply`, `quick-reaction`, `backdrop-dismiss`, `virtualized-latest` and
  `thread-target` stages.
- Those records preserve 35 direct assertions, five Room-readiness expansions,
  three four-record sheet-clearance expansions and two one-record position-
  restoration expansions.
- Matrix REST may arrange Accounts/Rooms/events and observe reaction state.
  Maestro owns every product action: login, Room opening, long presses,
  timeline/sheet swipes, Reply/reaction/Thread/jump actions and backdrop taps.
- Renderer access is read-only and may observe exact identity, geometry,
  virtualization, copy and visibility. It may not synthesize pointer/backdrop/
  scroll events, assign scroll offsets, call scroll methods or invoke handlers,
  click, focus, fill, submit or navigate.
- Every long press must use native input beyond Trinity's 500 ms threshold.
  Every target must stay connected inside its timeline and at least eight CSS
  pixels clear of the named sheet.
- Use one attempt, zero retries, finite observation and bounded
  Matrix/application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials/access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-action-sheet-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact long-press, Room fixture,
      sheet-clearance, restoration helper and five definition spans; pin touch,
      application-login and account source hashes.
- [ ] Prove 35 direct assertions plus exact helper expansions and require the
      five stage IDs with 18 + 4 + 4 + 18 + 10 unique identities.
- [ ] Require native >500 ms long press, one named `Message actions` dialog,
      no toolbar/revealed state, in-scroller target bounds, eight-pixel gap,
      sheet viewport bounds and native sheet scrolling to reachable Cancel.
- [ ] Require exact Reply/banner, quick `👍` plus real relation-event,
      action-free backdrop dismissal, 81-event virtualization/native oldest-
      history/latest restoration and Thread target position restoration.
- [ ] Reject synthesized pointer/backdrop/scroll events, hover controls,
      `scrollTop` assignment, `scrollIntoView`/scroll methods, DOM click/focus/
      fill/submit/navigation, retries, unbounded waits and weak cleanup/
      redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for long-press duration/trust, named
      surface/no-hover state, every geometry bound, Reply/reaction/backdrop
      semantics, exact 81 messages, virtual row cap, native scroll ownership,
      latest/Thread position restoration, cleanup and redaction.
- [ ] Run
      `pnpm exec vitest run scripts/message-action-sheet-migration.spec.mjs`
      and preserve the expected RED result.

## Task 2: Add the exact contract and observation seams

**Files:**

- Create `e2e/android/message-action-sheet-contract.mts`.
- Create `e2e/android/message-action-sheet-observer.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts`.
- Modify `e2e/android/account-workspace-client.mts` only if the previously
  planned generic native swipe/backdrop point seam needs a bounded extension.

- [ ] Export exact source mappings and explicit per-stage assertion maps;
      assert 54 identities, 18 + 4 + 4 + 18 + 10 grouping and global uniqueness
      at module load.
- [ ] Arrange one fresh Account/private Room per stage, send exact ready target
      events and retain stable event-id selectors; for virtualization, send
      exactly 80 ordered fillers followed by one newest target.
- [ ] Add closure-private reaction observation for a ready `m.reaction` sent by
      the exact Account with `m.relates_to.event_id` equal to the target and key
      exactly `👍`; return only sanitized event facts.
- [ ] Add read-only target/sheet geometry observation: target connection,
      scroller bounds, sheet bounds, viewport bounds, eight-pixel clearance and
      scroller-relative top.
- [ ] Reuse/extend native swipe to prove direction/offset changes inside the
      timeline or sheet, and add native exposed-backdrop tapping whose measured
      point is outside the sheet but inside the visible overlay.
- [ ] Keep credentials/tokens inside fixture closures and return only sanitized
      Room/event/geometry/relation receipts.
- [ ] Extend the focused guard so wrong message count/order, unstable selector,
      weak relation identity, vacuous/disconnected geometry, untransformed
      points, wrong swipe/backdrop region or leaked secrets fail.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement Reply, reaction and backdrop stages

**Files:**

- Create `e2e/android/message-action-sheet-journeys.mts`.

- [ ] Implement `reply` (18 records): open the exact Room/target, prove no
      toolbar and body width above 200 px, long-press natively, prove the single
      named surface/no revealed row/all target-sheet/viewport bounds, scroll the
      sheet natively until Cancel is reachable, choose Reply natively, prove
      sheet closure and exact Replying-to banner.
- [ ] Implement `quick-reaction` (4 records): open/long-press the exact target,
      prove the action sheet, tap only exact `sheet-react-👍` natively, prove
      closure and a ready visible reaction backed by the exact Matrix relation
      event/sender/key.
- [ ] Implement `backdrop-dismiss` (4 records): open/long-press the exact target,
      tap a measured exposed backdrop point natively, prove sheet closure,
      absence of reply banner and absence of a new reaction/action event.
- [ ] Keep stage fixtures isolated so reaction or composer state from one stage
      cannot satisfy another.

## Task 4: Implement virtualization and Thread stages

**Files:**

- Continue `e2e/android/message-action-sheet-journeys.mts`.

- [ ] Implement `virtualized-latest` (18 records): prove the virtual list,
      repeatedly native-swipe toward older history until exact filler 0 renders,
      prove jump-to-latest visible, activate it natively, prove the single newest
      target visible, jump hidden and fewer than 80 rendered rows.
- [ ] Record the target's scroller-relative top, long-press it natively, prove
      named sheet, one connected target, full clearance and latest state, then
      backdrop-dismiss natively and prove sheet gone, target visible, relative
      top restored within two pixels and latest state preserved.
- [ ] Implement `thread-target` (10 records): open target actions, choose Thread
      natively, prove Thread view and exact row, record its relative top,
      long-press that row, prove named sheet and full clearance, then native
      backdrop-dismiss and prove closure plus position restored within two
      pixels.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, event/native-input/geometry receipts and aggregate
      cleanup and redaction scans for all five stages.
- [ ] Always close any sheet/Thread, clear installed application data, close
      clients and release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-action-sheet` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-action-sheet` as required current hosted
      Android coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after media-retention with a bounded
      wrapper and started marker; add started-only
      `android-message-action-sheet` diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 54 identities/grouping, native gesture/
      action boundaries, exact surface/geometry/reaction/virtualization/Thread
      proof, secrets, teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 6: Local runtime, review, publication and hosted acceptance

- [ ] Run all focused/source-selected static gates and run
      `pnpm nx run trinity-e2e-android:message-action-sheet --skipNxCache`
      three times sequentially on unchanged inputs; require 5/5 stages, 54/54
      identities, attempt 1 and retries 0 each time.
- [ ] Scan all retained diagnostics for credentials, access/session tokens and
      bearer patterns; require no raster artifacts and clean Matrix/
      application/device teardown.
- [ ] Run the complete unchanged message-action-sheet browser predecessor with
      one worker and `--retries=0`; require all five definitions to pass and
      recheck all four pinned hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Review the complete feature diff; resolve every finding, re-run
      publication checks, commit task-owned files and push the consolidated
      branch while keeping PR #677 draft/open and unmerged.
- [ ] Audit first hosted merge SHA, renderer/APK/profile, five browser
      predecessors, dedicated Android artifact, 5/5 stages, 54/54 identities,
      attempt 1/retries 0, native-input/geometry/reaction receipts, redaction,
      teardown and clean worktree.
- [ ] Post evidence to #742, #660, #653 and PR #677; close #742 only after all
      acceptance evidence is complete, then continue with #743.
